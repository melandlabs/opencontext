import { getRawMessageManager } from "@melandlabs/opencontext";

interface IncomingMessage {
  id: string;
  user_id: string;
  text: string;
  platform: string;
  timestamp: number;
}

async function handleIncomingMessage(msg: IncomingMessage) {
  const messages = await getRawMessageManager();

  await messages.storeMessages([{
    messageId: msg.id,
    userId: msg.user_id,
    content: msg.text,
    platform: msg.platform,
    botId: "my-bot",
    timestamp: msg.timestamp,
    createdAt: Date.now(),
  }]);

  console.log(`Stored message ${msg.id}`);
}

async function main() {
  const exampleMessage: IncomingMessage = {
    id: `msg-${Date.now()}`,
    user_id: "user-123",
    text: "User prefers dark mode",
    platform: "slack",
    timestamp: Date.now(),
  };

  await handleIncomingMessage(exampleMessage);
}

main().catch((error) => {
  console.error("Remember-everything example failed:", error);
  process.exit(1);
});
