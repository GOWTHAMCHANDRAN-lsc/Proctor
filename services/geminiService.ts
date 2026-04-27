import { GoogleGenAI, Type } from "@google/genai";
import { Question, QuestionType } from "../types";

// Helper to generate a unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

export const generateQuestions = async (topic: string, count: number = 5, difficulty: string = 'Intermediate'): Promise<Question[]> => {
  if (!process.env.API_KEY) {
    console.error("API Key missing");
    throw new Error("API Key is missing. Please check your environment configuration.");
  }

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  const prompt = `Generate ${count} multiple-choice questions about "${topic}" at ${difficulty} level. 
  Ensure questions are clear, accurate, and suitable for an enterprise examination system.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        systemInstruction: "You are a senior academic exam setter. Return strictly structured JSON.",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              text: { type: Type.STRING, description: "The question text" },
              options: { 
                type: Type.ARRAY, 
                items: { type: Type.STRING },
                description: "List of 4 possible answers"
              },
              correctOptionIndex: { type: Type.INTEGER, description: "Index (0-3) of the correct answer" },
              marks: { type: Type.INTEGER, description: "Marks for this question, usually 1-5" }
            },
            required: ["text", "options", "correctOptionIndex", "marks"]
          }
        }
      }
    });

    if (response.text) {
      const rawQuestions = JSON.parse(response.text);
      // Map to our internal type
      return rawQuestions.map((q: any) => ({
        id: generateId(),
        text: q.text,
        type: QuestionType.MCQ,
        options: q.options,
        correctOptionIndex: q.correctOptionIndex,
        marks: q.marks || 1
      }));
    }
    return [];
  } catch (error) {
    console.error("Failed to generate questions:", error);
    throw error;
  }
};
