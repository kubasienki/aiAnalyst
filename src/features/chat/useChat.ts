import { useEffect, useState, useSyncExternalStore } from "react";
import { createChatApi } from "./chat-api";
import { ChatController } from "./controller";
import { createBrowserChatStorage } from "./storage";

export function useChat() {
  const [controller] = useState(() => new ChatController({
    api: createChatApi(),
    storage: createBrowserChatStorage(),
    newId: () => crypto.randomUUID(),
  }));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);

  useEffect(() => {
    void controller.initialize();
    function synchronizeAvailability() {
      controller.setOnline(navigator.onLine);
      controller.setAvailable(navigator.onLine && document.visibilityState === "visible");
    }
    synchronizeAvailability();
    window.addEventListener("focus", synchronizeAvailability);
    window.addEventListener("online", synchronizeAvailability);
    window.addEventListener("offline", synchronizeAvailability);
    document.addEventListener("visibilitychange", synchronizeAvailability);
    return () => {
      window.removeEventListener("focus", synchronizeAvailability);
      window.removeEventListener("online", synchronizeAvailability);
      window.removeEventListener("offline", synchronizeAvailability);
      document.removeEventListener("visibilitychange", synchronizeAvailability);
      controller.dispose();
    };
  }, [controller]);

  return { state, controller };
}
