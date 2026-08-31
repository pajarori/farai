import { id } from "../utils";
import type { EmailMessageReference, EmailMessageSummary } from "./types";

export class EmailMessageRegistry {
  private readonly references = new Map<string, Map<string, EmailMessageReference>>();
  private readonly idsByProviderKey = new Map<string, Map<string, string>>();

  register(sessionId: string, emailId: string, message: EmailMessageSummary): EmailMessageSummary {
    const key = `${emailId}\u0000${message.id}`;
    const ids = this.sessionProviderKeys(sessionId);
    let messageId = ids.get(key);
    if (!messageId) {
      messageId = id();
      ids.set(key, messageId);
      this.sessionReferences(sessionId).set(messageId, {
        id: messageId,
        sessionId,
        emailId,
        providerMessageId: message.id
      });
    }
    return { ...message, id: messageId };
  }

  resolve(sessionId: string, messageId: string): EmailMessageReference {
    const reference = this.references.get(sessionId)?.get(messageId);
    if (!reference) throw new Error(`email message not found: ${messageId}. call email_inbox or email_wait first`);
    return reference;
  }

  clearSession(sessionId: string): void {
    this.references.delete(sessionId);
    this.idsByProviderKey.delete(sessionId);
  }

  private sessionReferences(sessionId: string): Map<string, EmailMessageReference> {
    let references = this.references.get(sessionId);
    if (!references) {
      references = new Map();
      this.references.set(sessionId, references);
    }
    return references;
  }

  private sessionProviderKeys(sessionId: string): Map<string, string> {
    let ids = this.idsByProviderKey.get(sessionId);
    if (!ids) {
      ids = new Map();
      this.idsByProviderKey.set(sessionId, ids);
    }
    return ids;
  }
}

export const emailMessageRegistry = new EmailMessageRegistry();
