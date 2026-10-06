import { parseChatRequest, type ConversationMessage } from "../../../shared/chat";
import { ChatError } from "../../../server/chat/chat-service";
import { createChat } from "../../../server/config/chat";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let messages: ConversationMessage[];
  try {
    messages = parseChatRequest(await request.json());
  } catch (error) {
    let message = "Invalid conversation.";
    if (error instanceof SyntaxError) {
      message = "Invalid JSON.";
    } else if (error instanceof Error) {
      message = error.message;
    }
    return Response.json({ error: message }, { status: 400 });
  }

  try {
    const content = await createChat()(messages, request.signal);
    return Response.json({ content });
  } catch (error) {
    if (error instanceof ChatError) {
      const statuses = { configuration: 503, provider: 502, timeout: 504, cancelled: 499 };
      return Response.json({ error: error.message }, { status: statuses[error.code] });
    }
    return Response.json({ error: "Chat failed. Please retry." }, { status: 500 });
  }
}
