import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import rtms from '@zoom/rtms';

const config = {
  port: Number(process.env.PORT || 8080),
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',
  zoomClientId: process.env.ZM_RTMS_CLIENT || '',
  zoomClientSecret: process.env.ZM_RTMS_SECRET || '',
  zoomWebhookSecret: process.env.ZOOM_WEBHOOK_SECRET_TOKEN || '',
  zoomEventSubscriptionMode: String(process.env.ZOOM_EVENT_SUBSCRIPTION_MODE || 'webhook').toLowerCase(),
  zoomEventWsEndpoint: process.env.ZOOM_EVENT_WS_ENDPOINT || '',
  zoomOAuthTokenUrl: process.env.ZOOM_OAUTH_TOKEN_URL || 'https://zoom.us/oauth/token?grant_type=client_credentials',
  windmillBaseUrl: (process.env.WINDMILL_BASE_URL || 'https://windmill.app.thatworkshop.dev').replace(/\/$/, ''),
  windmillWorkspace: process.env.WINDMILL_WORKSPACE || 'that-workshop',
  windmillToken: process.env.WINDMILL_TOKEN || '',
  windmillScriptPath: process.env.WINDMILL_SCRIPT_PATH || 'f/workshop_signal_compiler/zoom_rtms_transcript_chunk_to_signal',
  dryRun: String(process.env.DRY_RUN || 'false').toLowerCase() === 'true',
  websocketHeartbeatMs: Number(process.env.ZOOM_EVENT_WS_HEARTBEAT_MS || 30_000),
  websocketReconnectMinMs: Number(process.env.ZOOM_EVENT_WS_RECONNECT_MIN_MS || 2_000),
  websocketReconnectMaxMs: Number(process.env.ZOOM_EVENT_WS_RECONNECT_MAX_MS || 60_000),
};

if (!config.zoomClientId || !config.zoomClientSecret) {
  console.warn('ZM_RTMS_CLIENT / ZM_RTMS_SECRET are not set. RTMS join and Zoom event WebSocket auth will fail until configured.');
}
if (!config.windmillToken) {
  console.warn('WINDMILL_TOKEN is not set. Transcript forwarding will fail until configured.');
}
if (config.zoomEventSubscriptionMode === 'websocket' && !config.zoomEventWsEndpoint) {
  console.warn('ZOOM_EVENT_SUBSCRIPTION_MODE=websocket but ZOOM_EVENT_WS_ENDPOINT is not set. Zoom event WebSocket will not start.');
}

const app = express();

// Need raw body for Zoom signature validation in webhook mode.
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));

const clientsByMeeting = new Map();
const streamToMeeting = new Map();
let httpServer = null;
let zoomAccessTokenCache = null;
let zoomEventWs = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let shuttingDown = false;
const zoomEventWsState = {
  enabled: config.zoomEventSubscriptionMode === 'websocket',
  status: config.zoomEventSubscriptionMode === 'websocket' ? 'configured' : 'disabled',
  lastConnectedAt: null,
  lastMessageAt: null,
  lastError: null,
  reconnectAttempts: 0,
};

function timingSafeEqualString(a, b) {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function validateZoomSignature(req) {
  if (!config.zoomWebhookSecret) return false;
  const timestamp = req.get('x-zm-request-timestamp');
  const signature = req.get('x-zm-signature');
  if (!timestamp || !signature) return false;

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;

  const message = `v0:${timestamp}:${req.rawBody || ''}`;
  const digest = crypto
    .createHmac('sha256', config.zoomWebhookSecret)
    .update(message)
    .digest('hex');
  return timingSafeEqualString(`v0=${digest}`, signature);
}

function handleUrlValidation(body) {
  const plainToken = body?.payload?.plainToken;
  if (!plainToken || !config.zoomWebhookSecret) return null;
  return {
    plainToken,
    encryptedToken: crypto
      .createHmac('sha256', config.zoomWebhookSecret)
      .update(plainToken)
      .digest('hex'),
  };
}

async function postToWindmill(args) {
  const encodedPath = encodeURIComponent(config.windmillScriptPath);
  const url = `${config.windmillBaseUrl}/api/w/${config.windmillWorkspace}/jobs/run/p/${encodedPath}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.windmillToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Windmill POST failed: ${response.status} ${text.slice(0, 500)}`);
  }
  return text;
}

function normalizeRtmsPayload(payload = {}) {
  const object = payload.object || {};
  return {
    ...payload,
    meeting_uuid: payload.meeting_uuid || object.meeting_uuid || object.uuid || object.id,
    rtms_stream_id: payload.rtms_stream_id || object.rtms_stream_id || object.stream_id,
    server_urls: payload.server_urls || object.server_urls,
    signature: payload.signature || object.signature,
    meeting_url: payload.meeting_url || object.meeting_url || object.join_url || payload.join_url,
  };
}

function getMeetingUuid(payload) {
  const normalized = normalizeRtmsPayload(payload);
  return normalized.meeting_uuid || 'unknown-meeting';
}

function getStreamId(payload) {
  return normalizeRtmsPayload(payload).rtms_stream_id || '';
}

function buildWindmillArgs(rtmsPayload, data, timestamp, metadata) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
  const meetingUuid = getMeetingUuid(rtmsPayload);
  const participantId = String(metadata?.userId || metadata?.user_id || metadata?.participantId || 'unknown-participant');
  const speakerName = metadata?.userName || metadata?.user_name || metadata?.name || 'Unknown Speaker';
  const startTime = Number(metadata?.startTime || metadata?.start_time || timestamp || Date.now());
  const endTime = Number(metadata?.endTime || metadata?.end_time || timestamp || Date.now());

  return {
    meeting_uuid: meetingUuid,
    transcript_text: text,
    speaker_name: speakerName,
    participant_id: participantId,
    start_time: startTime,
    end_time: endTime,
    meeting_url: rtmsPayload?.meeting_url || rtmsPayload?.join_url || '',
    language: String(metadata?.language || ''),
    dry_run: config.dryRun,
  };
}

function joinRtms(payload) {
  const normalizedPayload = normalizeRtmsPayload(payload);
  const meetingUuid = getMeetingUuid(normalizedPayload);
  const streamId = getStreamId(normalizedPayload);

  if (!normalizedPayload.meeting_uuid || !normalizedPayload.rtms_stream_id || !normalizedPayload.server_urls || !normalizedPayload.signature) {
    console.error('Cannot join RTMS stream: started event payload is missing meeting_uuid, rtms_stream_id, server_urls, or signature.');
    return;
  }

  if (clientsByMeeting.has(meetingUuid)) {
    console.log(`RTMS client already active for ${meetingUuid}`);
    return;
  }

  const client = new rtms.Client();
  clientsByMeeting.set(meetingUuid, client);
  if (streamId) streamToMeeting.set(streamId, meetingUuid);

  client.onTranscriptData(async (data, size, timestamp, metadata) => {
    try {
      const args = buildWindmillArgs(normalizedPayload, data, timestamp, metadata);
      if (!args.transcript_text.trim()) return;
      const jobId = await postToWindmill(args);
      console.log(`Forwarded transcript chunk for ${meetingUuid}; bytes=${size}; windmill_job=${jobId}`);
    } catch (error) {
      console.error('Failed to forward transcript chunk', error);
    }
  });

  client.onLeave?.((reason) => {
    console.log(`RTMS left ${meetingUuid}: ${reason}`);
    clientsByMeeting.delete(meetingUuid);
    if (streamId) streamToMeeting.delete(streamId);
  });

  client.onJoinConfirm?.((reason) => {
    console.log(`RTMS joined ${meetingUuid}: ${reason}`);
  });

  client.join({
    meeting_uuid: normalizedPayload.meeting_uuid,
    rtms_stream_id: normalizedPayload.rtms_stream_id,
    server_urls: normalizedPayload.server_urls,
    signature: normalizedPayload.signature,
  });
}

function leaveRtms(payload) {
  const normalizedPayload = normalizeRtmsPayload(payload);
  const streamId = getStreamId(normalizedPayload);
  const meetingUuid = getMeetingUuid(normalizedPayload);
  const mappedMeetingUuid = streamId ? streamToMeeting.get(streamId) : undefined;
  const key = clientsByMeeting.has(meetingUuid) ? meetingUuid : mappedMeetingUuid;
  if (!key) {
    console.log(`RTMS stopped event for unknown meeting/stream: meeting=${meetingUuid}; stream=${streamId || 'unknown-stream'}`);
    return;
  }

  const client = clientsByMeeting.get(key);
  try {
    client?.leave?.();
  } catch (error) {
    console.error(`Failed to leave RTMS stream for ${key}`, error);
  } finally {
    clientsByMeeting.delete(key);
    if (streamId) streamToMeeting.delete(streamId);
  }
}

function handleZoomEvent(eventEnvelope) {
  const event = eventEnvelope?.event;
  const payload = eventEnvelope?.payload || {};
  if (!event) return;

  if (event === 'meeting.rtms_started' || event === 'webinar.rtms_started' || event === 'session.rtms_started') {
    joinRtms(payload);
    return;
  }

  if (event === 'meeting.rtms_stopped' || event === 'webinar.rtms_stopped' || event === 'session.rtms_stopped') {
    leaveRtms(payload);
    return;
  }

  if (event.includes?.('rtms')) {
    console.log(`Ignoring RTMS event: ${event}`);
  }
}

async function getZoomAccessToken() {
  const now = Date.now();
  if (zoomAccessTokenCache && zoomAccessTokenCache.expiresAt > now + 60_000) {
    return zoomAccessTokenCache.accessToken;
  }
  if (!config.zoomClientId || !config.zoomClientSecret) {
    throw new Error('Zoom client credentials are not configured.');
  }

  const basicToken = Buffer.from(`${config.zoomClientId}:${config.zoomClientSecret}`).toString('base64');
  const response = await fetch(config.zoomOAuthTokenUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicToken}`,
      'Accept': 'application/json',
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Zoom OAuth token request failed: ${response.status} ${text.slice(0, 500)}`);
  }
  const body = JSON.parse(text);
  const accessToken = body.access_token || body.Access_token;
  const expiresIn = Number(body.expires_in || body.Expire_in || 3600);
  if (!accessToken) throw new Error('Zoom OAuth token response did not include access_token.');

  zoomAccessTokenCache = {
    accessToken,
    expiresAt: now + Math.max(60, expiresIn) * 1000,
  };
  return accessToken;
}

function buildZoomWebSocketUrl(accessToken) {
  const url = new URL(config.zoomEventWsEndpoint);
  url.searchParams.set('access_token', accessToken);
  return url.toString();
}

function clearZoomWebSocketTimers() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  heartbeatTimer = null;
  reconnectTimer = null;
}

function scheduleZoomEventWebSocketReconnect(reason) {
  if (shuttingDown || config.zoomEventSubscriptionMode !== 'websocket') return;
  if (reconnectTimer) return;
  reconnectAttempts += 1;
  zoomEventWsState.reconnectAttempts = reconnectAttempts;
  const delay = Math.min(
    config.websocketReconnectMaxMs,
    config.websocketReconnectMinMs * 2 ** Math.min(reconnectAttempts - 1, 6),
  );
  zoomEventWsState.status = `reconnecting in ${delay}ms`;
  console.warn(`Zoom event WebSocket reconnect scheduled in ${delay}ms: ${reason}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectZoomEventWebSocket().catch((error) => {
      zoomEventWsState.lastError = error.message;
      scheduleZoomEventWebSocketReconnect(error.message);
    });
  }, delay);
}

async function connectZoomEventWebSocket() {
  if (config.zoomEventSubscriptionMode !== 'websocket') return;
  if (!config.zoomEventWsEndpoint) {
    zoomEventWsState.status = 'missing endpoint';
    return;
  }

  clearZoomWebSocketTimers();
  if (zoomEventWs) {
    try { zoomEventWs.close(); } catch (_error) { /* noop */ }
    zoomEventWs = null;
  }

  const accessToken = await getZoomAccessToken();
  const wsUrl = buildZoomWebSocketUrl(accessToken);
  zoomEventWsState.status = 'connecting';

  zoomEventWs = new WebSocket(wsUrl);

  zoomEventWs.on('open', () => {
    reconnectAttempts = 0;
    zoomEventWsState.reconnectAttempts = 0;
    zoomEventWsState.status = 'connected';
    zoomEventWsState.lastConnectedAt = new Date().toISOString();
    zoomEventWsState.lastError = null;
    console.log('Zoom event WebSocket connected.');

    heartbeatTimer = setInterval(() => {
      if (zoomEventWs?.readyState === WebSocket.OPEN) {
        zoomEventWs.send(JSON.stringify({ module: 'heartbeat' }));
      }
    }, config.websocketHeartbeatMs);
  });

  zoomEventWs.on('message', (data) => {
    zoomEventWsState.lastMessageAt = new Date().toISOString();
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data || '');
    try {
      const message = JSON.parse(text);
      if (message?.module === 'heartbeat') return;
      handleZoomEvent(message);
    } catch (error) {
      console.error(`Failed to parse Zoom event WebSocket message: ${error.message}`);
    }
  });

  zoomEventWs.on('error', (error) => {
    zoomEventWsState.lastError = error.message;
    console.error('Zoom event WebSocket error', error.message);
  });

  zoomEventWs.on('close', (code, reasonBuffer) => {
    clearZoomWebSocketTimers();
    const reason = reasonBuffer?.toString?.() || '';
    zoomEventWsState.status = `closed (${code})`;
    if (!shuttingDown) scheduleZoomEventWebSocketReconnect(`closed ${code} ${reason}`.trim());
  });
}

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    activeMeetings: clientsByMeeting.size,
    eventSubscription: {
      mode: config.zoomEventSubscriptionMode,
      websocket: zoomEventWsState,
    },
  });
});

app.post(config.webhookPath, (req, res) => {
  const body = req.body || {};

  if (body.event === 'endpoint.url_validation') {
    const challenge = handleUrlValidation(body);
    if (!challenge) return res.status(400).json({ error: 'Invalid Zoom URL validation payload' });
    return res.json(challenge);
  }

  if (!validateZoomSignature(req)) {
    return res.status(401).json({ error: 'Invalid Zoom webhook signature' });
  }

  handleZoomEvent(body);

  res.json({ ok: true });
});

function shutdown() {
  shuttingDown = true;
  clearZoomWebSocketTimers();
  if (zoomEventWs) zoomEventWs.close();
  for (const [meetingUuid, client] of clientsByMeeting.entries()) {
    try { client?.leave?.(); } catch (_error) { /* noop */ }
    clientsByMeeting.delete(meetingUuid);
  }
  if (httpServer) {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

httpServer = app.listen(config.port, () => {
  console.log(`Zoom RTMS transcript bridge listening on :${config.port}${config.webhookPath}`);
  if (config.zoomEventSubscriptionMode === 'websocket') {
    connectZoomEventWebSocket().catch((error) => {
      zoomEventWsState.lastError = error.message;
      console.error('Failed to start Zoom event WebSocket', error.message);
      scheduleZoomEventWebSocketReconnect(error.message);
    });
  }
});
