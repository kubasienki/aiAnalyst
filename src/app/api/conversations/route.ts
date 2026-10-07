import { withConversationApplication } from "../../../server/config/http";

export const runtime = "nodejs";

export async function POST() {
  return withConversationApplication(service => service.create(), 201);
}
