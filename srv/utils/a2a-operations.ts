import type { Message, Task, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import { v4 as uuidv4 } from "uuid";

type Ids = { taskId: string; contextId: string };

export function createNewTask(message: Message, ids: Ids): Task {
    return {
        kind: "task",
        id: ids.taskId,
        contextId: ids.contextId,
        status: { state: "submitted", timestamp: new Date().toISOString() },
        history: [message],
        metadata: message.metadata,
    };
}

/** parts[0] e sempre o texto; dados estruturados opcionais vao em parts[1] (DataPart). */
export function createMessage(text: string, ids: Ids, data?: Record<string, unknown>): Message {
    return {
        kind: "message",
        messageId: uuidv4(),
        role: "agent",
        parts: data ? [{ kind: "text", text }, { kind: "data", data }] : [{ kind: "text", text }],
        taskId: ids.taskId,
        contextId: ids.contextId,
    };
}

export function createStatusUpdate(
    state: "working" | "completed" | "input-required" | "failed",
    text: string,
    ids: Ids,
    data?: Record<string, unknown>
): TaskStatusUpdateEvent {
    const final = state !== "working";
    return {
        kind: "status-update",
        taskId: ids.taskId,
        contextId: ids.contextId,
        status: { state, message: createMessage(text, ids, data), timestamp: new Date().toISOString() },
        final,
    };
}
