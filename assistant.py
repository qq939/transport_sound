import json
import os
import time
from typing import List, Dict, Any
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser
from pydantic import BaseModel, Field
import dotenv

dotenv.load_dotenv()

# Define data structure for output parsing
class AnalysisResult(BaseModel):
    words: List[str] = Field(description="List of difficult vocabulary words (IELTS level), max 4 words.")
    source_guess: str = Field(description="A guess of the exact source")

class Assistant:
    def __init__(self, history_file="langchain_history.json"):
        self.history_file = history_file
        # Initialize LLM. 
        # Note: Expects OPENAI_API_KEY in environment variables.
        # If not present, this might raise an error when called.
        # Users should ensure env var is set or pass api_key explicitly if we extended this.
        try:
            self.llm = ChatOpenAI(model="THUDM/glm-4-9b-chat", base_url="https://api.siliconflow.cn/v1", api_key=os.getenv("SILICONFLOW_API_KEY"))
        except Exception as e:
            print(f"Warning: Failed to initialize ChatOpenAI. Ensure OPENAI_API_KEY is set. Error: {e}")
            self.llm = None

        self.history = self._load_history()

    def _load_history(self) -> List[Dict]:
        if not os.path.exists(self.history_file):
            return []
        try:
            with open(self.history_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading history: {e}")
            return []

    def _save_history(self):
        try:
            with open(self.history_file, 'w', encoding='utf-8') as f:
                json.dump(self.history, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"Error saving history: {e}")

    def analyze_sentence(self, sentence: str) -> Dict[str, Any]:
        """
        Analyzes the sentence to extract difficult vocabulary and save to history.
        """
        if not self.llm:
            return {"error": "LLM not initialized. Check API Key."}

        # 1. Analyze with LangChain
        parser = JsonOutputParser(pydantic_object=AnalysisResult)
        
        prompt = ChatPromptTemplate.from_messages([
            ("system", "You are an English language expert. Analyze the given sentence."),
            ("user", "Extract up to 4 difficult vocabulary words (IELTS level) from the following sentence.\n"
                     "Also find out the exact source.\n"
                     "Return JSON format.\n\n"
                     "Sentence: {sentence}\n\n"
                     "{format_instructions}")
        ])

        chain = prompt | self.llm | parser

        try:
            result = chain.invoke({
                "sentence": sentence,
                "format_instructions": parser.get_format_instructions()
            })
            
            words = result.get("words", [])
            source_guess = result.get("source_guess", "Unknown")
            
            # 2. Check history for these words
            history_matches = self._find_word_history(words)

            # 3. Save current entry to history
            timestamp = time.time()
            new_entry = {
                "timestamp": timestamp,
                "sentence": sentence,
                "source": source_guess, # Using the guessed source or user input if we had it
                "vocabulary": words
            }
            self.history.append(new_entry)
            self._save_history()

            return {
                "current_analysis": {
                    "words": words,
                    "source": source_guess,
                    "timestamp": timestamp
                },
                "history_matches": history_matches
            }

        except Exception as e:
            print(f"Error during analysis: {e}")
            return {"error": str(e)}

    def _find_word_history(self, words: List[str]) -> Dict[str, List[Dict]]:
        """
        Finds past occurrences of the given words in the history.
        Returns a dict: { "word": [ { "sentence": ..., "source": ..., "timestamp": ... } ] }
        """
        matches = {}
        for word in words:
            word_lower = word.lower()
            word_matches = []
            for entry in self.history:
                # Check if word exists in this entry's vocabulary (case-insensitive)
                # entry['vocabulary'] is a list of strings
                if any(w.lower() == word_lower for w in entry.get("vocabulary", [])):
                    word_matches.append({
                        "sentence": entry.get("sentence"),
                        "source": entry.get("source"),
                        "timestamp": entry.get("timestamp")
                    })
            
            if word_matches:
                matches[word] = word_matches
        return matches

# Singleton instance or create new one in app
assistant = Assistant()
