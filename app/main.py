"""Compatibility entry point. The UI is served by FastAPI, not Streamlit.

Run from the project root:
    python -m uvicorn api.main:app --host 127.0.0.1 --port 8000
"""
from api.main import app

__all__ = ["app"]

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("api.main:app", host="127.0.0.1", port=8000, reload=False)
