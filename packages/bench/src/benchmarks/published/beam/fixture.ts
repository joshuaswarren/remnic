/**
 * Small BEAM smoke fixture for quick-mode benchmark validation.
 */

export interface BeamChatTurn {
  content: string;
  role: string;
  id?: number | string;
  index?: string;
  question_type?: string;
  time_anchor?: string;
}

export interface BeamQuestion {
  question: string;
  rubric?: string[];
  difficulty?: string;
  answer?: string;
  ideal_answer?: string;
  ideal_response?: string;
  ideal_summary?: string;
  expected_compliance?: string;
  instruction_being_tested?: string;
  preference_being_tested?: string;
  plan_reference?: string;
  source_chat_ids?: unknown;
  [key: string]: unknown;
}

export type BeamQuestionMap = Record<string, BeamQuestion[]>;

export interface BeamPlan {
  plan_id?: number | string;
  chat?: BeamChatTurn[][] | BeamChatTurn[] | BeamPlanChatMap[];
  [key: string]: unknown;
}

export interface BeamPlanChatBatch {
  turns?: BeamChatTurn[][] | BeamChatTurn[];
  [key: string]: unknown;
}

export type BeamPlanChatMap = Record<string, BeamPlanChatBatch[] | null>;

export interface BeamConversation {
  conversation_id: string | number;
  chat: BeamChatTurn[][] | BeamChatTurn[] | BeamPlanChatMap[];
  probing_questions: BeamQuestionMap | string;
  plans?: BeamPlan[];
  [key: string]: unknown;
}

export const BEAM_SMOKE_FIXTURE: BeamConversation[] = [
  {
    conversation_id: "beam-smoke-1",
    chat: [
      [
        {
          id: 1,
          index: "1,1",
          question_type: "main_question",
          role: "user",
          content:
            "Please help me ship the first sprint of my budget tracker. I want sprint one to end on March 29.",
          time_anchor: "March-15-2024",
        },
        {
          id: 2,
          index: "1,2",
          question_type: "assistant_response",
          role: "assistant",
          content:
            "Sprint one ending on March 29 sounds reasonable. We can stage auth, expenses, and analytics before then.",
          time_anchor: "March-15-2024",
        },
      ],
      [
        {
          id: 3,
          index: "2,1",
          question_type: "main_question",
          role: "user",
          content:
            "For the transactions table, I want to add two new columns: category and notes.",
          time_anchor: "March-20-2024",
        },
        {
          id: 4,
          index: "2,2",
          question_type: "assistant_response",
          role: "assistant",
          content:
            "Got it. I will treat category and notes as the two new transaction columns.",
          time_anchor: "March-20-2024",
        },
      ],
      [
        {
          id: 5,
          index: "3,1",
          question_type: "main_question",
          role: "user",
          content:
            "Please remember this instruction: whenever I ask about implementation, format the answer with syntax-highlighted code blocks.",
          time_anchor: "March-22-2024",
        },
        {
          id: 6,
          index: "3,2",
          question_type: "assistant_response",
          role: "assistant",
          content:
            "Understood. I'll use syntax-highlighted code blocks for implementation guidance.",
          time_anchor: "March-22-2024",
        },
        {
          id: 7,
          index: "3,3",
          question_type: "main_question",
          role: "user",
          content:
            "After the caching work, the dashboard API now averages around 250ms.",
          time_anchor: "March-24-2024",
        },
      ],
    ],
    probing_questions: {
      information_extraction: [
        {
          question: "When does my first sprint end?",
          answer: "March 29",
          difficulty: "easy",
          rubric: ["LLM response should state: March 29"],
          plan_reference: "Batch 1, Bullet 1",
          source_chat_ids: [1, 2],
        },
      ],
      knowledge_update: [
        {
          question: "What is the average response time of the dashboard API now?",
          answer: "250ms",
          difficulty: "easy",
          rubric: ["LLM response should state: 250ms"],
          plan_reference: "Batch 3, Bullet 3",
          source_chat_ids: [7],
        },
      ],
      multi_session_reasoning: [
        {
          question: "How many new columns did I want to add to the transactions table?",
          answer: "Two columns: category and notes.",
          difficulty: "easy",
          rubric: [
            "LLM response should state: Two columns",
            "LLM response should state: category and notes",
          ],
          plan_reference: "Batch 2, Bullet 1",
          source_chat_ids: [3, 4],
        },
      ],
      instruction_following: [
        {
          question: "Could you show me how to implement a login feature?",
          instruction_being_tested:
            "Always format implementation help with syntax-highlighted code blocks.",
          expected_compliance:
            "Response should include code blocks with syntax highlighting.",
          difficulty: "medium",
          rubric: [
            "LLM response should contain: code blocks with syntax highlighting",
          ],
          plan_reference: "Batch 3, Bullet 1",
          source_chat_ids: [5, 6],
        },
      ],
    },
  },
];
