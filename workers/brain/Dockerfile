# Brain worker — Python classification worker for the iii engine.
#
# Installs only the lightweight runtime deps (iii-sdk). The SLM path
# (llama-cpp-python) is intentionally NOT installed: BRAIN_SELECTOR defaults
# to "heuristic", and pulling llama-cpp-python would add a multi-minute
# native build to every image rebuild. Set BRAIN_SELECTOR=slm and add the
# dependency here if you want in-container SLM classification.
FROM python:3.12-slim

WORKDIR /app

COPY workers/brain/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY workers/brain/src/ ./src/

# main.py imports its siblings as top-level modules (`from selector import ...`)
ENV PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1

CMD ["python", "src/main.py"]
