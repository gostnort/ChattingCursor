local_llm GGUF 推理 sidecar（llama.cpp / llama-cpp-python）

安装依赖：
  pip install -r local_llm/server/requirements-inference.txt

硬件自检：
  python local_llm/server/check_hardware.py

环境变量（Bridge 启动 sidecar 时会传入）：
  LOCAL_LLM_WEIGHTS_DIR   GGUF 所在目录
  LOCAL_LLM_N_GPU_LAYERS  GPU 层数；-1=尽量全 GPU；12 GB 显存跑 26B 建议 35
  LOCAL_LLM_N_CTX         上下文长度，默认 8192
  LOCAL_LLM_DEFER_MODEL_LOAD=1  延迟到首条消息或 POST /v1/load 再加载

混合模式（VRAM + RAM）：
  当 GGUF 大于显存时，llama.cpp 将部分 Transformer 层放在 GPU、其余在 CPU 内存。
  RTX 4070 12 GB + 26B Q4_K_M（约 15 GB）推荐 LOCAL_LLM_N_GPU_LAYERS=35。
  Q8_0 26B（约 25 GB）在 12 GB 显卡上也能混合加载，但首次加载慢、推理较慢；
  更推荐 Q4_K_M 或 gemma-4-E4B（约 8 GB）。

API：
  GET  /v1/health   status: idle|loading|ready|error
  POST /v1/load     触发 GGUF 加载（defer 模式）
  POST /v1/chat/completions
