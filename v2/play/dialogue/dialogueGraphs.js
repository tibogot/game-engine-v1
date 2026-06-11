/**
 * Dialogue graphs keyed by id. Loaded into DialogueRunner at boot.
 * @typedef {{ speaker?: string, text: string, next?: string | null, choices?: { text: string, next: string | null }[] }} DialogueNode
 * @typedef {{ id: string, start: string, nodes: Record<string, DialogueNode> }} DialogueGraph
 */

/** @type {Record<string, DialogueGraph>} */
export const DIALOGUE_GRAPHS = {
  villager_greet: {
    id: "villager_greet",
    start: "hello",
    nodes: {
      hello: {
        speaker: "Villager",
        text: "Oh—hello! I did not expect anyone up here.",
        next: "hint",
      },
      hint: {
        speaker: "Villager",
        text: "The old road east leads to the shrine. Mind the cliffs.",
        next: "bye",
      },
      bye: {
        speaker: "Villager",
        text: "Safe travels.",
        next: null,
      },
    },
  },
  elder_choice: {
    id: "elder_choice",
    start: "open",
    nodes: {
      open: {
        speaker: "Elder",
        text: "You have the look of someone who seeks answers.",
        next: "ask",
      },
      ask: {
        speaker: "Elder",
        text: "Will you help guard the meadow tonight?",
        choices: [
          { text: "I will help.", next: "yes" },
          { text: "Not tonight.", next: "no" },
        ],
      },
      yes: {
        speaker: "Elder",
        text: "Good. Stand where the grass is tallest—we will find you.",
        next: null,
      },
      no: {
        speaker: "Elder",
        text: "No matter. The wind remembers anyway.",
        next: null,
      },
    },
  },
};

export function getDialogueGraph(id) {
  if (!id) return null;
  return DIALOGUE_GRAPHS[id] ?? null;
}

export function listDialogueGraphIds() {
  return Object.keys(DIALOGUE_GRAPHS);
}
