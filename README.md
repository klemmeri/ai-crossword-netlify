# AI Newspaper-Style Crossword Generator

This is a Netlify-ready prototype for an AI-run crossword app.

## What it does

- Lets a user enter a theme or genre.
- Lets a user choose Easy, Medium, or Hard.
- Calls a Netlify Function so the OpenAI API key is not exposed in the browser.
- Requests a 15x15 American newspaper-style crossword grid.
- Validates the returned grid for:
  - 15 rows and 15 columns
  - uppercase letters and black squares only
  - 180-degree black-square rotational symmetry
  - minimum 3-letter entries
  - checked white cells
  - connected white-cell area
  - duplicate answers
- Renders an interactive grid with Across and Down clues.
- Includes Check, Reveal Letter, Reveal Puzzle, and Print buttons.

## Important limitation

This is a first prototype. It delegates the hardest construction step to the AI and then validates the result. A production-grade crossword app should eventually add a local fill engine, curated crossword dictionary, grid-template library, and clue editor.

## Local development

```bash
npm install
npx netlify dev
```

Create a `.env` file for local testing:

```bash
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=gpt-4.1-mini
```

## Netlify deployment

1. Put this folder in a GitHub repository.
2. Connect the repository to Netlify.
3. In Netlify, set the environment variable:

```text
OPENAI_API_KEY = your OpenAI API key
```

Optional:

```text
OPENAI_MODEL = gpt-4.1-mini
```

4. Deploy the site.

The static app calls:

```text
/.netlify/functions/generate-puzzle
```

The function calls OpenAI's Responses API server-side.

## Next engineering steps

1. Add a curated crossword answer dictionary.
2. Add a library of validated 15x15 symmetric grid templates.
3. Build a real backtracking fill engine.
4. Use the AI only for theme suggestions and clue writing, not for raw grid construction.
5. Add save/share/export features.
