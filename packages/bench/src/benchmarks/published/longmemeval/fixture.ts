interface HaystackTurn {
  role: "user" | "assistant";
  content: string;
}

export interface LongMemEvalItem {
  question_id: string | number;
  question_type: string;
  question: string;
  answer: string;
  question_date: string;
  haystack_dates: string[];
  haystack_session_ids: string[];
  haystack_sessions: HaystackTurn[][];
  answer_session_ids: string[];
}

export const LONG_MEM_EVAL_SMOKE_FIXTURE: LongMemEvalItem[] = [
  {
    question_id: 1,
    question_type: "single-session-user",
    question: "What city does the user live in?",
    answer: "Paris",
    question_date: "2025-01-01",
    haystack_dates: ["2024-12-01"],
    haystack_session_ids: ["session-1"],
    haystack_sessions: [
      [
        { role: "user", content: "I moved to Paris last year." },
        { role: "assistant", content: "Paris sounds great." },
      ],
    ],
    answer_session_ids: ["session-1"],
  },
];
