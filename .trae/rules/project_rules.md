本项目规则：
- 使用Flask + flask-sock提供WebSocket音频流服务。
- 前端优先使用AudioWorklet回放PCM，避免ScriptProcessor造成高延迟。
- 遇到音频缓冲积压时丢弃旧数据以保证实时性（追帧）。
- 所有自动化变更遵循用户的git与工作记录规则。