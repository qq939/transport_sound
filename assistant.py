from datetime import datetime
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
class WordInfo(BaseModel):
    word: str = Field(description="The difficult English word or expression")
    meaning: str = Field(description="The correct Chinese meaning of the difficult English word or expression in the origin sentance")
    options: List[str] = Field(description="4 options, all are wrong Chinese meanings of the difficult English word or expression")

class AnalysisResult(BaseModel):
        # - If no word replaced, return an empty list
        # - Drop words shorter than 6 chars
        # - Drop words not nouns/verbs/adjectives, or overly basic beginner words
    words: List[WordInfo] = Field(description="List of difficult vocabulary words and expressions.")
    source_guess: str = Field(description="A guess of the exact source(e.g. this is a line from Friends Season 1, Episode 12 at 5 minute 13 second, and at that time xxxx)")

class Assistant:
    def __init__(self, history_file="langchain_history.json"):
        self.history_file = history_file
        # Initialize LLM. 
        # Note: Expects OPENAI_API_KEY in environment variables.
        # If not present, this might raise an error when called.
        # Users should ensure env var is set or pass api_key explicitly if we extended this.
        try:
            self.llm = ChatOpenAI(model="deepseek-ai/DeepSeek-V3", base_url="https://api.siliconflow.cn/v1", api_key=os.getenv("SILICONFLOW_API_KEY"))
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
        Analyzes the sentence to extract difficult vocabulary and generate quiz options.
        Does NOT save to history yet. History is updated after quiz submission.
        """
        if not self.llm:
            return {"error": "LLM not initialized. Check API Key."}

        # 1. Analyze with LangChain
        parser = JsonOutputParser(pydantic_object=AnalysisResult)
        
        prompt = ChatPromptTemplate.from_messages([
            ("system", "You are an English language expert. Analyze the given sentence."),
            ("user", "Extract up to 4 difficult vocabulary words (IELTS level) from the following sentence.\n"
                     "For each word, provide its correct Chinese meaning and 3 other confusing Chinese meanings as options.\n"
                     "CRITICAL: Ensure the 'meaning' field is EXACTLY present in the 'options' list.\n"
                     "Also find out the exact source.\n"
                     "IMPORTANT: Return ONLY PURE JSON. Do NOT include comments (like //), markdown blocks (```json), or any other text.\n\n"
                     "Sentence: {sentence}\n\n"
                     "{format_instructions}")
        ])

        # chain = prompt | self.llm | parser
        # We need to access token usage, so we invoke LLM directly or use callbacks if using chain.
        # But invoke() on ChatOpenAI returns an AIMessage which has response_metadata['token_usage']
        
        formatted_prompt = prompt.invoke({
            "sentence": sentence,
            "format_instructions": parser.get_format_instructions()
        })
        
        try:
            response = self.llm.invoke(formatted_prompt)
            # Parse output
            result = parser.parse(response.content)
            
            # Get token usage
            token_usage = response.response_metadata.get("token_usage", {})
            
            # words is now a list of dicts (WordInfo)
            words_info = result.get("words", [])
            source_guess = result.get("source_guess", "Unknown")
            
            # Validate options
            for word_item in words_info:
                meaning = word_item.get("meaning")
                options = word_item.get("options", [])
                
                # Ensure meaning is in options
                if meaning and options and meaning not in options:
                    # Replace the first option with the correct meaning if missing
                    # or append if less than 4 (but schema says 4 options)
                    if len(options) >= 1:
                        options[0] = meaning
                    else:
                        options.append(meaning)
                    word_item["options"] = options
            
            return {
                "words": words_info,
                "source": source_guess,
                "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "sentence": sentence,
                "token_usage": token_usage
            }

        except Exception as e:
            print(f"Error during analysis: {e}")
            return {"error": str(e)}

    def submit_quiz_result(self, quiz_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Processes the quiz result.
        quiz_data: {
            "sentence": str,
            "source": str,
            "timestamp": str, # Formatted string
            "results": [
                {"word": str, "is_correct": bool}
            ]
        }
        """
        sentence = quiz_data.get("sentence")
        source = quiz_data.get("source")
        timestamp = quiz_data.get("timestamp")
        if not timestamp:
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        results = quiz_data.get("results", [])

        
        # Filter words that were answered incorrectly
        wrong_words = {}
        all_correct = True
        
        for res in results:
            if not res.get("is_correct"):
                all_correct = False
                word = res.get("word")
                # Get current count from history or init to 0
                current_count = self._get_word_error_count(word)
                wrong_words[word] = current_count + 1
        
        if all_correct:
            return {"status": "success", "message": "All correct! No history saved."}
        
        # If there are wrong words, save to history
        new_entry = {
            "timestamp": timestamp,
            "sentence": sentence,
            "source": source,
            "vocabulary": wrong_words # Dict[word, count]
        }
        
        self.history.append(new_entry)
        self._save_history()
        
        return {"status": "success", "message": "History saved with error counts.", "saved_entry": new_entry}

    def _get_word_error_count(self, word: str) -> int:
        """
        Calculates the total error count for a word from history.
        Note: The user requirement implies 'accumulated error count'.
        However, the structure is a list of entries.
        We can sum up the counts or take the last one.
        Assuming 'vocabulary' in history entry is { "word": count }.
        We will search for the latest count or sum them up?
        The requirement says: "reimbursement" :错误计数（历史累计）
        So we should probably find the previous total count.
        """
        total_count = 0
        word_lower = word.lower()
        
        for entry in self.history:
            vocab = entry.get("vocabulary", {})
            # vocab can be a list (old format) or dict (new format)
            if isinstance(vocab, list):
                continue # Skip old format
            
            for w, count in vocab.items():
                if w.lower() == word_lower:
                    # We assume the history stores the count at that moment.
                    # Or does it store the increment?
                    # Let's assume we want to know the *latest* accumulated count.
                    # But simpler approach: count how many times it appeared in history?
                    # No, the JSON example shows "count" as value.
                    # So let's look for the Max existing count in history?
                    if isinstance(count, int) and count > total_count:
                        total_count = count
        
        return total_count

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
