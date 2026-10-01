import crypto from "crypto";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

function verifySlackRequest(req, rawBody) {
  if (!SLACK_SIGNING_SECRET) {
    console.error("DIAG missing SLACK_SIGNING_SECRET");
    return false;
  }
  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSignature = req.headers["x-slack-signature"];
  if (!timestamp || !slackSignature) {
    console.error("DIAG missing Slack signature headers");
    return false;
  }
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    console.error("DIAG Slack request timestamp too old");
    return false;
  }
  const sigBase = `v0:${timestamp}:${rawBody}`;
  const mySignature = "v0=" + crypto.createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(sigBase, "utf8").digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature, "utf8"),
      Buffer.from(slackSignature, "utf8")
    );
  } catch (error) {
    console.error("DIAG signature comparison failed:", error?.message);
    return false;
  }
}

async function postToSlack(channel, text, threadTs) {
  if (!SLACK_BOT_TOKEN) {
    console.error("DIAG missing SLACK_BOT_TOKEN");
    return;
  }
  console.log("DIAG Posting reply to Slack", { channel, threadTs: threadTs || null });
  try {
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
  } catch (error) {
    console.error("DIAG Slack post exception:", error?.message);
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "Dr. Chappy Slack endpoint",
      diagnostic: true,
    });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  const rawBody = typeof req.body === "string"
    ? req.body
    : JSON.stringify(req.body ?? {});

  if (!verifySlackRequest(req, rawBody)) {
    console.error("DIAG Slack signature verification failed");
    return res.status(401).json({ ok: false, error: "invalid_signature" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (error) {
    console.error("DIAG invalid JSON:", error?.message);
    return res.status(400).json({ ok: false, error: "invalid_json" });
  }

  console.log("DIAG Slack request received", {
    type: body?.type || null,
    eventType: body?.event?.type || null,
  });

  if (body?.type === "url_verification") {
    console.log("DIAG URL verification challenge received");
    return res.status(200).json({ challenge: body.challenge });
  }

  if (body?.type === "event_callback") {
    const event = body.event;
    if (event?.bot_id) {
      console.log("DIAG ignoring bot event");
      return res.status(200).json({ ok: true });
    }
    if (event?.type === "app_mention") {
      console.log("DIAG app_mention detected", {
        channel: event.channel,
        user: event.user || null,
        ts: event.ts || null,
      });

      res.status(200).json({ ok: true });

      await postToSlack(
        event.channel,
        "社長、お呼びでしょうか。本日も出勤しております🤖",
        event.thread_ts || event.ts
      );
      return;
    }
  }

  console.log("DIAG request acknowledged; no matching event handler");
  return res.status(200).json({ ok: true });
}
