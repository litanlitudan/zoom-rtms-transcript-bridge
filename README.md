# Zoom RTMS Transcript Bridge

Thin service for Workshop SOP 1. It keeps the long-lived Zoom event subscription and RTMS SDK/WebSocket session outside Windmill and forwards transcript chunks into the Windmill script:

```text
f/workshop_signal_compiler/zoom_rtms_transcript_chunk_to_signal
```

## Why this exists

Windmill is used for orchestration, normalization, Baserow writes, review digest, and Paca handoff. Zoom RTMS is a meeting-duration realtime SDK/WebSocket workload, so this bridge owns only:

- Zoom webhook validation / URL challenge when using webhook mode
- Zoom event WebSocket connection / OAuth token refresh / heartbeat / reconnect when using WebSocket mode
- RTMS join / leave on `meeting.rtms_started` and `meeting.rtms_stopped`
- transcript packet callbacks
- in-memory live transcript recording for realtime inspection via HTTP
- retrying POSTs to Windmill

It must not do offering/topic extraction.

## Environment

Copy `.env.example` to `.env` and fill values.

Required:

- `ZM_RTMS_CLIENT`
- `ZM_RTMS_SECRET`
- `ZOOM_WEBHOOK_SECRET_TOKEN`
- `ZOOM_EVENT_SUBSCRIPTION_MODE=websocket`
- `ZOOM_EVENT_WS_ENDPOINT`
- `WINDMILL_BASE_URL`
- `WINDMILL_WORKSPACE`
- `WINDMILL_TOKEN`

## Run

```bash
npm install
npm start
```

For the current Workshop deployment, configure the Zoom app event subscription as **WebSocket** and set `ZOOM_EVENT_WS_ENDPOINT` to the endpoint URL copied from Zoom Marketplace. The service obtains a Zoom OAuth client-credentials token, appends it to the endpoint URL, sends a heartbeat every 30 seconds, reconnects with backoff, and routes RTMS started/stopped events into the RTMS SDK join/leave path.

Webhook mode remains available for local testing or future deployments: set `ZOOM_EVENT_SUBSCRIPTION_MODE=webhook` and expose `POST /webhook` as the Zoom RTMS webhook endpoint.

## Realtime inspection endpoints

```text
GET /healthz                 # service, WebSocket, recent Zoom event, and active meeting status
GET /transcripts             # summary of recorded meetings/chunk counts
GET /transcripts/:meetingUuid # full in-memory transcript for one meeting
```

Each transcript chunk is recorded in memory immediately and then forwarded to Windmill for Baserow persistence. The in-memory store is intended for realtime debugging/inspection; Baserow remains the SOP source of truth.

## Windmill payload mapping

Each transcript packet is sent to Windmill as:

```json
{
  "meeting_uuid": "...",
  "transcript_text": "...",
  "speaker_name": "...",
  "participant_id": "...",
  "start_time": 123,
  "end_time": 456,
  "meeting_url": "...",
  "language": "...",
  "dry_run": false
}
```
