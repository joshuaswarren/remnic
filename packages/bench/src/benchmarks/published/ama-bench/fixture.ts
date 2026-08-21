export interface TrajectoryTurn {
  turn_idx: number;
  action: string;
  observation: string;
}

export interface QAPair {
  question: string;
  answer: string;
  type: string;
  question_uuid: string;
}

export interface AMABenchEpisode {
  episode_id: number;
  task: string;
  task_type: string;
  domain: string;
  success: boolean;
  num_turns: number;
  total_tokens: number;
  trajectory: TrajectoryTurn[];
  qa_pairs: QAPair[];
}

export const AMA_BENCH_SMOKE_FIXTURE: AMABenchEpisode[] = [
  {
    episode_id: 1,
    task: "Web task smoke fixture",
    task_type: "web",
    domain: "WEB",
    success: true,
    num_turns: 2,
    total_tokens: 32,
    trajectory: [
      {
        turn_idx: 1,
        action: "Open the account settings page.",
        observation: "The profile shows the user's preferred language is Spanish.",
      },
      {
        turn_idx: 2,
        action: "Review the notification section.",
        observation: "Email notifications are disabled.",
      },
    ],
    qa_pairs: [
      {
        question: "What language preference did the profile show?",
        answer: "Spanish",
        type: "recall",
        question_uuid: "ama-smoke-q1",
      },
      {
        question: "Were email notifications enabled or disabled?",
        answer: "disabled",
        type: "state_updating",
        question_uuid: "ama-smoke-q2",
      },
    ],
  },
];
