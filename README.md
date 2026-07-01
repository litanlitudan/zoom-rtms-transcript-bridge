# Zoom RTMS Transcript Bridge

Thin service for Workshop SOP 1. It keeps the long-lived Zoom RTMS SDK/WebSocket session outside Windmill and forwards transcript chunks into the Windmill script:

```text
f/workshop_signal_compiler/zoom_rtms_transcript_chunk_to_signal
```

## Why this exists

Windmill is used for orchestration, normalization, Baserow writes, review digest, and Paca handoff. Zoom RTMS is a meeting-duration realtime SDK/WebSocket workload, so this bridge owns only:

- Zoom webhook validation / URL challenge
- RTMS join
- transcript packet callbacks
- retrying POSTs to Windmill

It must not do offering/topic extraction.

## Environment

Copy `.env.example` to `.env` and fill values.

Required:

- `ZM_RTMS_CLIENT`
- `ZM_RTMS_SECRET`
- `ZOOM_WEBHOOK_SECRET_TOKEN`
- `WINDMILL_BASE_URL`
- `WINDMILL_WORKSPACE`
- `WINDMILL_TOKEN`

## Run

```bash
npm install
npm start
```

Expose `POST /webhook` as the Zoom RTMS webhook endpoint.

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
