const crypto = require("crypto");

function verifySlackSignature(req, rawBody) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return false;

  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSignature = req.headers["x-slack-signature"];
  if (!timestamp || !slackSignature) return false;

  // Reject requests older than 5 minutes.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto
    .createHmac("sha256", signingSecret)
    .update(base)
    .digest("hex")}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(slackSignature, "utf8")
    );
  } catch {
    return false;
  }
}

async function postToSlack(channel, text, threadTs) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN is not configured.");

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });

  const data = await response.json();
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({
      ok: true,
      service: "Dr. Chappy Slack endpoint",
    });
  }

  const rawBody =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});

  if (!verifySlackSignature(req, rawBody)) {
    return res.status(401).send("Invalid Slack signature");
  }

  let body;
  try {
    body = typeof req.body === "object" ? req.body : JSON.parse(rawBody);
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  // Slack checks the Request URL with this challenge.
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Acknowledge Slack immediately.
  res.status(200).send("OK");

  const event = body.event;
  if (!event || event.type !== "app_mention" || event.bot_id) return;

  try {
    await postToSlack(
      event.channel,
      "社長、お呼びでしょうか。本日も出勤しております🤖",
      event.thread_ts || event.ts
    );
  } catch (error) {
    console.error(error);
  }
};
