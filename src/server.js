import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import rtms from '@zoom/rtms';

const config = {
  port: Number(process.env.PORT || 8080),
  webhookPath: process.env.WEBHOOK_PATH || '/webhook',
  zoomWebhookSecret: process.env.ZOOM_WEBHOOK_SECRET_TOKEN || '',
  windmillBaseUrl: (process.env.WINDMILL_BASE_URL || 'https://windmill.app.thatworkshop.dev').replace(/\/$/, ''),
  windmillWorkspace: process.env.WINDMILL_WORKSPACE || 'that-workshop',
  windmillToken: process.env.WINDMILL_TOKEN || '',
  windmillScriptPath: process.env.WINDMILL_SCRIPT_PATH || 'f/workshop_signal_compiler/zoom_rtms_transcript_chunk_to_signal',
  dryRun: String(process.env.DRY_RUN || 'false').toLowerCase() === 'true',
};

if (!process.env.ZM_RTMS_CLIENT || !process.env.ZM_RTMS_SECRET) {
  console.warn('ZM_RTMS_CLIENT / ZM_RTMS_SECRET are not set. RTMS join will fail until configured.');
}
if (!config.windmillToken) {
  console.warn('WINDMILL_TOKEN is not set. Transcript forwarding will fail until configured.');
}

const app = express();

// Need raw body for Zoom signature validation.
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));

const clients = new Map();

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

function getMeetingUuid(payload) {
  return payload?.meeting_uuid || payload?.object?.uuid || payload?.object?.id || 'unknown-meeting';
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
  const meetingUuid = getMeetingUuid(payload);
  if (clients.has(meetingUuid)) {
    console.log(`RTMS client already active for ${meetingUuid}`);
    return;
  }

  const client = new rtms.Client();
  clients.set(meetingUuid, client);

  client.onTranscriptData(async (data, size, timestamp, metadata) => {
    try {
      const args = buildWindmillArgs(payload, data, timestamp, metadata);
      if (!args.transcript_text.trim()) return;
      const jobId = await postToWindmill(args);
      console.log(`Forwarded transcript chunk for ${meetingUuid}; windmill_job=${jobId}`);
    } catch (error) {
      console.error('Failed to forward transcript chunk', error);
    }
  });

  client.onLeave?.((reason) => {
    console.log(`RTMS left ${meetingUuid}: ${reason}`);
    clients.delete(meetingUuid);
  });

  client.onJoinConfirm?.((reason) => {
    console.log(`RTMS joined ${meetingUuid}: ${reason}`);
  });

  client.join({
    meeting_uuid: payload.meeting_uuid,
    rtms_stream_id: payload.rtms_stream_id,
    server_urls: payload.server_urls,
    signature: payload.signature,
  });
}

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, activeMeetings: clients.size });
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

  if (body.event === 'meeting.rtms_started' || body.event === 'webinar.rtms_started' || body.event === 'session.rtms_started') {
    joinRtms(body.payload || {});
  }

  res.json({ ok: true });
});

app.listen(config.port, () => {
  console.log(`Zoom RTMS transcript bridge listening on :${config.port}${config.webhookPath}`);
});
