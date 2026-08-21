export interface UserProfile {
  uuid: string;
  name: string;
  age: number;
  gender: string;
  [key: string]: unknown;
}

export interface AMemGymSessionMessage {
  role: string;
  content: string;
}

export interface AMemGymSession {
  event: string | null;
  exposed_states: Record<string, string>;
  query: string;
  messages: AMemGymSessionMessage[];
  session_time: string;
}

export interface AMemGymPeriod {
  period_start: string;
  period_end: string;
  period_summary: string;
  sessions: AMemGymSession[];
  state: Record<string, string>;
  updates: Record<string, string>;
  update_cnts: Record<string, number>;
}

export interface AnswerChoice {
  state: string[];
  answer: string;
}

export interface AMemGymQA {
  query: string;
  required_info: string[];
  answer_choices: AnswerChoice[];
}

export interface AMemGymProfile {
  id: string;
  start_time: string;
  user_profile: UserProfile;
  state_schema: Record<string, unknown>;
  periods: AMemGymPeriod[];
  qas: AMemGymQA[];
}

export const AMEMGYM_SMOKE_FIXTURE: AMemGymProfile[] = [
  {
    id: "smoke-profile-1",
    start_time: "2025-01-01T00:00:00Z",
    user_profile: {
      uuid: "smoke-user-1",
      name: "Maya",
      age: 29,
      gender: "female",
    },
    state_schema: {
      city: { type: "string" },
      favorite_snack: { type: "string" },
    },
    periods: [
      {
        period_start: "2025-01-01T00:00:00Z",
        period_end: "2025-01-31T23:59:59Z",
        period_summary: "Maya moved and updated her travel snack preference.",
        sessions: [
          {
            event: "Maya relocated to Chicago for a new job.",
            exposed_states: { city: "Chicago" },
            query: "I moved to Chicago last month and I am still getting used to the cold.",
            messages: [
              {
                role: "assistant",
                content: "Chicago winters can be intense. I will remember that you live there now.",
              },
            ],
            session_time: "2025-01-10T09:00:00Z",
          },
          {
            event: null,
            exposed_states: { favorite_snack: "trail mix" },
            query: "For train rides I always pack trail mix because it is easy to carry.",
            messages: [],
            session_time: "2025-01-12T13:00:00Z",
          },
        ],
        state: {
          city: "Chicago",
          favorite_snack: "trail mix",
        },
        updates: {
          city: "Chicago",
          favorite_snack: "trail mix",
        },
        update_cnts: {
          city: 1,
          favorite_snack: 1,
        },
      },
    ],
    qas: [
      {
        query: "What city does Maya live in now?",
        required_info: ["city"],
        answer_choices: [
          { state: ["Chicago"], answer: "Chicago" },
          { state: ["Austin"], answer: "Austin" },
        ],
      },
      {
        query: "Which snack should Maya pack for the train ride?",
        required_info: ["favorite_snack"],
        answer_choices: [
          { state: ["trail mix"], answer: "trail mix" },
          { state: ["pretzels"], answer: "pretzels" },
        ],
      },
    ],
  },
];
