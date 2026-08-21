export interface PersonaMemChatMessage {
  role: string;
  content: string;
}

export interface PersonaMemChatHistory {
  metadata?: Record<string, unknown>;
  chat_history: PersonaMemChatMessage[];
}

export interface PersonaMemSample {
  personaId: string;
  userQuery: string;
  correctAnswer: string;
  incorrectAnswers?: string[];
  chatHistory: PersonaMemChatHistory;
  topicQuery?: string;
  preference?: string;
  topicPreference?: string;
  prefType?: string;
  relatedConversationSnippet?: string;
  who?: string;
  updated?: string;
  prevPref?: string;
  chatHistory32kLink?: string;
  chatHistory128kLink?: string;
}

export const PERSONAMEM_SMOKE_FIXTURE: PersonaMemSample[] = [
  {
    personaId: "personamem-smoke-1",
    userQuery: "Which tea do I usually drink while journaling in the morning?",
    correctAnswer: "Earl Grey",
    preference: "Earl Grey while journaling",
    prefType: "implicit_preference",
    relatedConversationSnippet:
      "I like to journal every morning with a mug of Earl Grey tea.",
    chatHistory: {
      metadata: { persona_id: "personamem-smoke-1" },
      chat_history: [
        {
          role: "system",
          content: "You are a personalized assistant helping a user over time.",
        },
        {
          role: "user",
          content: "I like to journal every morning with a mug of Earl Grey tea.",
        },
        {
          role: "assistant",
          content: "Noted: journaling pairs with Earl Grey tea for you.",
        },
      ],
    },
  },
  {
    personaId: "personamem-smoke-1",
    userQuery: "What music do I tend to put on when I cook on Sunday evenings?",
    correctAnswer: "jazz piano",
    incorrectAnswers: [
      "classical violin",
      "podcast interviews",
      "silent kitchen",
    ],
    preference: "jazz piano while cooking on Sunday evenings",
    prefType: "implicit_preference",
    relatedConversationSnippet:
      "On Sunday evenings I usually cook pasta with soft jazz piano playing in the background.",
    chatHistory: {
      metadata: { persona_id: "personamem-smoke-1" },
      chat_history: [
        {
          role: "system",
          content: "You are a personalized assistant helping a user over time.",
        },
        {
          role: "user",
          content:
            "On Sunday evenings I usually cook pasta with soft jazz piano playing in the background.",
        },
        {
          role: "assistant",
          content:
            "Got it. Sunday evening cooking means pasta and jazz piano for you.",
        },
      ],
    },
  },
];
