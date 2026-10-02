import { create } from 'zustand';

interface TypingIndicator {
  contactId: string;
  showUntil: number;
}

interface AppState {
  // Typing Indicator
  typingIndicators: Map<string, TypingIndicator>;
  setTypingIndicator: (contactId: string, showUntil: number) => void;
  clearTypingIndicator: (contactId: string) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // Typing Indicators
  typingIndicators: new Map(),
  setTypingIndicator: (contactId, showUntil) =>
    set((state) => {
      const updated = new Map(state.typingIndicators);
      updated.set(contactId, { contactId, showUntil });
      return { typingIndicators: updated };
    }),
  clearTypingIndicator: (contactId) =>
    set((state) => {
      const updated = new Map(state.typingIndicators);
      updated.delete(contactId);
      return { typingIndicators: updated };
    }),
}));
