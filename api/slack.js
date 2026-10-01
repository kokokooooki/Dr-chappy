import crypto from "crypto";

export const config = { api: { bodyParser: false } };

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function verifySlackRequest(req, rawBody) {
  if (!SLACK_SIGNING_SECRET) return false;
  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSignature = req.headers["x-slack-signature"];
  if (!timestamp || !slackSignature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = "v0=" + crypto.createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`, "utf8").digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(slackSignature));
  } catch {
    return false;
  }
}

async function postToSlack(channel, text, threadTs) {
  console.log("DIAG Posting reply to Slack", { channel, threadTs: threadTs || null });

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });

  const data = await response.json();
  console.log("DIAG Slack API result", {
    httpStatus: response.status,
    ok: data.ok,
    error: data.error || null,
    channel: data.channel || null,
    ts: data.ts || null,
  });

  return data;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, service: "Dr. Chappy Slack endpoint", version: "raw-body-fix-2" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    console.error("DIAG raw body read failed:", e?.message);
    return res.status(400).json({ ok: false, error: "raw_body_read_failed" });
  }

  if (!verifySlackRequest(req, rawBody)) {
    console.error("DIAG Slack signature verification failed");
    return res.status(401).json({ ok: false, error: "invalid_signature" });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }

  if (body?.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  if (body?.type === "event_callback") {
    const event = body.event;
    if (event?.bot_id) return res.status(200).json({ ok: true });

    if (event?.type === "app_mention") {
      console.log("DIAG app_mention detected", {
        channel: event.channel,
        user: event.user || null,
        ts: event.ts || null,
      });

      try {
        await postToSlack(
          event.channel,
          "社長、お呼びでしょうか。本日も出勤しております🤖",
          event.thread_ts || event.ts
        );
      } catch (e) {
        console.error("DIAG Slack post exception:", e?.message);
      }

      return res.status(200).json({ ok: true });
    }
  }

  return res.status(200).json({ ok: true });
}
