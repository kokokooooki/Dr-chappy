import crypto from "crypto";

export const config = { api: { bodyParser: false } };

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function verifySlackRequest(req, rawBody) {
  if (!SLACK_SIGNING_SECRET) return false;

  const timestamp = req.headers["x-slack-request-timestamp"];
  const slackSignature = req.headers["x-slack-signature"];
  if (!timestamp || !slackSignature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected =
    "v0=" +
    crypto
      .createHmac("sha256", SLACK_SIGNING_SECRET)
      .update(`v0:${timestamp}:${rawBody}`, "utf8")
      .digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(slackSignature, "utf8")
    );
  } catch {
    return false;
  }
}

async function askOpenAI(userText) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.6",
      instructions:
        "あなたは（株）AIアシスタンツのAI社員「Dr.チャッピー」です。相手は社長です。日本語で自然に、親しみやすく簡潔に答えてください。分からないことは推測で断定しないでください。",
      input: userText,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error("OpenAI API error", {
      status: response.status,
      error: data?.error?.message || data?.error || "unknown_error",
    });
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  if (data.output_text) return data.output_text;

  const text = data?.output
    ?.flatMap((item) => item?.content || [])
    ?.filter((item) => item?.type === "output_text")
    ?.map((item) => item?.text)
    ?.join("\n");

  return text || "社長、回答の生成には成功しましたが、文章を取り出せませんでした🤖";
}

async function postToSlack(channel, text, threadTs) {
  if (!SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is missing");

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
  if (!data.ok) throw new Error(`Slack API error: ${data.error || "unknown_error"}`);
}

function removeBotMention(text = "") {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "Dr. Chappy",
      brain: "OpenAI",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return res.status(400).json({ ok: false, error: "raw_body_read_failed" });
  }

  if (!verifySlackRequest(req, rawBody)) {
    console.error("Slack signature verification failed");
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

    if (event?.bot_id) {
      return res.status(200).json({ ok: true });
    }

    if (event?.type === "app_mention") {
      // Slackへの受領応答は先に返す
      res.status(200).json({ ok: true });

      const userText = removeBotMention(event.text);

      try {
        const answer = await askOpenAI(
          userText || "社長から呼ばれました。短く挨拶してください。"
        );

        await postToSlack(
          event.channel,
          answer,
          event.thread_ts || event.ts
        );
      } catch (error) {
        console.error("Dr. Chappy error:", error?.message);

        try {
          await postToSlack(
            event.channel,
            "社長、脳みそとの通信でエラーが出ました🤖💦 Vercelのログを確認してください。",
            event.thread_ts || event.ts
          );
        } catch (postError) {
          console.error("Fallback Slack post failed:", postError?.message);
        }
      }

      return;
    }
  }

  return res.status(200).json({ ok: true });
}
