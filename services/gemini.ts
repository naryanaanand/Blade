import { GoogleGenAI, Type, Schema } from "@google/genai";
import { LevelData } from "../types";

const apiKey = process.env.API_KEY || '';
const ai = new GoogleGenAI({ apiKey });

const levelSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    themeName: {
      type: Type.STRING,
      description: "A catchy name for the level theme (e.g. 'Math Madness', 'Fruit Ninja', 'Tech Stack').",
    },
    instruction: {
      type: Type.STRING,
      description: "Short, punchy instruction on what to slash (e.g. 'Slash the ODD numbers!', 'Slash the RED fruits!').",
    },
    targets: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "List of 8-10 short words or items that MATCH the instruction (correct items).",
    },
    distractors: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "List of 8-10 short words or items that DO NOT match the instruction (wrong items).",
    },
  },
  required: ["themeName", "instruction", "targets", "distractors"],
};

export const generateLevel = async (): Promise<LevelData> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: "Create a random game level where the player must slash items of a specific category and avoid others. The items should be short strings (1-2 words).",
      config: {
        systemInstruction: "You are a Sensei creating training levels for a digital ninja. Create a categorization challenge.",
        responseMimeType: "application/json",
        responseSchema: levelSchema,
        temperature: 1.1,
      },
    });

    const text = response.text;
    if (!text) throw new Error("No response from Sensei");

    return JSON.parse(text) as LevelData;
  } catch (error) {
    console.error("Error generating level:", error);
    throw error;
  }
};