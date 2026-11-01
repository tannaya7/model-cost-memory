import uvicorn

if __name__ == "__main__":
    print("\n  Model & Cost Memory POC  →  open http://127.0.0.1:8000   (API docs: /docs, key: demo-key)\n")
    uvicorn.run("poc_engine.api:app", host="127.0.0.1", port=8000)
