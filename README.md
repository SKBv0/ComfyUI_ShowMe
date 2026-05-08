# ShowMe

ShowMe is a ComfyUI extension that adds an annotation layer to the canvas.

It is meant for two related uses:

- Ask what a graph does, follow data flow, and inspect important nodes.
- Mark up the graph and save notes for later review.

<img width="836" height="470" alt="image" src="https://github.com/user-attachments/assets/6df526ae-b45b-43ea-beea-ab3a4a3a1cb4" />

## Features

- Manual notes with brush, arrows, shapes, highlights, and text labels.
- Ask AI can read the current workflow and place explanations near the relevant nodes.
- Separate manual and AI annotation layers, so AI explanations can be replaced without deleting manual notes.
- Annotations are saved in the workflow JSON under `extra.showme_annotations`.




https://github.com/user-attachments/assets/b2a4d46c-3d7e-4160-b4db-d094858147e0








## Installation

Clone the repository into ComfyUI's `custom_nodes` folder:

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/SKBv0/ComfyUI_ShowMe.git
```

Restart ComfyUI after installing.

## Usage

1. In ComfyUI's bottom-right canvas controls, click the ShowMe pencil button.
2. Enable drawing when you want to mark the graph.
3. Open Ask AI for graph-aware explanations.

## AI Providers

Ask AI can use local or command-line providers when available:

- Ollama
- Claude CLI
- Codex CLI

Ollama defaults to:

```text
http://127.0.0.1:11434
```

## Notes

- Exported workflows can carry ShowMe annotations with them.
- Another ComfyUI install needs ShowMe installed to display those annotations.
