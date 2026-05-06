import { env } from "./env.ts";

export interface SendMessageParams {
  rid: string;
  text: string;
  authToken: string;
  userId: string;
  alias?: string;
  tmid?: string;
}

export async function sendMessage(p: SendMessageParams): Promise<string> {
  const body = {
    message: {
      rid: p.rid,
      msg: p.text,
      ...(p.alias ? { alias: p.alias } : {}),
      ...(p.tmid ? { tmid: p.tmid } : {}),
    },
  };
  const resp = await fetch(`${env.ROCKETCHAT_URL}/api/v1/chat.sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": p.authToken,
      "X-User-Id": p.userId,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`sendMessage failed ${resp.status}: ${text}`);
  }
  const data = (await resp.json()) as { message?: { _id?: string } };
  return data.message?._id ?? "";
}

/**
 * Update an existing message by _id. Used for streaming effect — post a
 * placeholder, then progressively edit with accumulating stdout.
 */
export async function updateMessage(p: {
  rid: string;
  msgId: string;
  text: string;
  authToken: string;
  userId: string;
}): Promise<void> {
  const body = { roomId: p.rid, msgId: p.msgId, text: p.text };
  const resp = await fetch(`${env.ROCKETCHAT_URL}/api/v1/chat.update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": p.authToken,
      "X-User-Id": p.userId,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`chat.update failed ${resp.status}: ${text}`);
  }
}
