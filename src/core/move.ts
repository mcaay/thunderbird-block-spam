// Moving messages with their read state. Thunderbird keeps the read state when it moves a
// message, and the moved copy has a new id, so the state is set before the move. Thunderbird
// does the same when it marks spam read and moves it.

import type { MailPort } from "./ports";
import type { FolderRef, MessageInfo } from "./types";

/**
 * Moves messages to a folder. With `read` given, the messages whose read state differs get it
 * first, and their old one back when the move fails. A read state that cannot be set does not
 * stop the move. Returns the ids whose read state was changed. Rejects when the move fails.
 */
export async function moveMessages(mail: MailPort, messages: readonly MessageInfo[], target: FolderRef, read: boolean | null): Promise<Set<number>> {
  const changing = read === null ? [] : messages.filter((message) => message.read !== read).map((message) => message.id);
  const changed = read === null || changing.length === 0 ? [] : await mail.setRead(changing, read).catch(() => []);
  try {
    await mail.move(
      messages.map((message) => message.id),
      target,
    );
  } catch (error) {
    if (read !== null && changed.length > 0) {
      await mail.setRead(changed, !read).catch(() => []);
    }
    throw error;
  }
  return new Set(changed);
}
