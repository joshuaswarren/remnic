export interface ArenaAnswer {
  target_asin?: string;
  attributes?: string[];
  [key: string]: unknown;
}

export type ArenaExpectedAnswer =
  | ArenaAnswer
  | string
  | Array<ArenaAnswer | string>;

export interface ArenaTask {
  id: number;
  questions: string[];
  answers: ArenaExpectedAnswer[];
  backgrounds?: string | string[];
  base_person?: ArenaBasePerson;
  category: string;
}

export interface ArenaBasePerson {
  name?: string;
  query?: string;
  daily_plans?: ArenaExpectedAnswer | null;
  [key: string]: unknown;
}

export interface DomainData {
  domain: string;
  tasks: ArenaTask[];
}

export const MEMORY_ARENA_SMOKE_FIXTURE: DomainData[] = [
  {
    domain: "bundled_shopping",
    tasks: [
      {
        id: 1,
        category: "bundled_shopping",
        questions: [
          "Buy a snack for the train ride that is compact, shareable, and not messy.",
          "Which snack from the completed train-ride purchase should I pack in the bag now?",
        ],
        answers: [
          { attributes: ["trail mix"] },
          { attributes: ["trail mix"] },
        ],
      },
    ],
  },
];
