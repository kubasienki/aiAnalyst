import { withConversationApplication } from "../../../server/conversations/http";

export const runtime = "nodejs";

export async function POST() {
  return withConversationApplication(service => service.create(), 201);
}
