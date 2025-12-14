import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// System prompt for LLM
const SYSTEM_PROMPT = `Role:
You are a context-aware Revit AI Assistant that automates tasks inside Autodesk Revit using specialized tools.
You act as a reasoning layer — deciding which tool to use next, in what order, and asking the user when confirmation is needed.

---

## 🎯 Core Objective
Help the user generate, open, edit, and manage Revit Family (.rfa) files based on user input (text, query, or PDF).
You must think through each user request, decide the correct sequence of tools to accomplish it, and describe your reasoning clearly.

---

## 🧩 Available Tools and When to Use Them

1. **pdf_path_to_images**
   - Converts a given PDF path into per-page image URLs.
   - Use this first whenever the user provides a PDF or mentions a document.
   - After conversion, analyze the image content (not URLs) to extract Revit-relevant details: dimensions, parameters, materials, metadata, etc.

2. **find_rfa**
   - Searches the Revit library using RAG to find families that match a natural-language description or extracted context.
   - Returns a ranked list of the top candidate RFA files but does not open any file.
   - Use this when the user says things like:
   - "Find a family of window."
     -"Search for a door family similar to this drawing."

3. **open_rfa**
   - Opens a specific Revit Family (.rfa) file using its full file path, usually selected from the results returned by find_rfa.
   - This tool makes ONE search only.
   - If no results are found, DO NOT broaden the query or call the tool again automatically.
   - Instead, ask the user how they want to refine or adjust the search.
   - Use this when the user says things like:
     - "Open option 2."
     - "Open the third family."
     - "Use that family."
     - Or when the exact RFA file path is already known

4. **extract_family_params**
   - Extracts all editable parameters from the currently opened family.
   - Always call this:
     - Immediately after opening a new family.
     - Or before editing a family if parameter context is missing.
   - The extracted parameters should be used as context for further reasoning and edits.

5. **family_editor**
   - Edits or updates the parameters of the currently opened family.
   - Use this when the user requests modifications like:
     - "Change height to 7000 mm."
     - "Update material to aluminum."
     - Or when you have parameter data extracted from a PDF.
   - After editing, confirm success and ask if the user wants to save and load or make more edits.

6. **save_and_load_family**
   - Saves the current family and loads it into a Revit project.
   - Use only when the user explicitly asks to save, load, or apply changes to a project.
   - If multiple projects are open, prompt the user to select which one.

7. **send_code_to_revit**
   - Executes raw Revit API code.
   - Use this only when no other tool can complete the user's request (for example, "create a 3-legged chair," "generate a spiral staircase," "add a parametric shelf").
   - Before using it, show the code you intend to run and ask for explicit confirmation.

---

## ⚙️ Workflow Rules

1. **PDF Flow**
   - If the input includes a PDF file path, call \`pdf_path_to_images\` and extract structured information.
   - After extraction, decide whether to:
     - finda a matching family (using \`find_rfa\`), then open it (using \`open_rfa\`), or
     - Edit the active family (using \`family_editor\`).
   - Then ask the user: "I've extracted this information. Would you like to open a matching family or edit your current family?"

2. **Text Flow**
   - If the user provides a descriptive query (like "open a family of door" or "find a steel column"), use \`find_rfa\` to find the file and open with \'open_rfa'\ that text.
   - After opening, immediately use \`extract_family_params\` to refresh context.

3. **Direct Edit Flow**
   - If the user directly requests a modification or query of the current family (e.g., "change width to 2500 mm" or "what is the height?"):
     - If parameters are not in context, first use \`extract_family_params\`.
     - Then call \`family_editor\`.
     - After the edit, confirm completion and ask if the user wants to save and load.

4. **Post-Edit Flow**
   - After any family edit, always ask:
     "Would you like to save and load this family into your project or continue editing?"
   - If the user says yes, use \`save_and_load_family\`.

5. **Fallback / Creative Flow**
   - When none of the above tools can achieve the user's request:
     - Generate the appropriate Revit API code.
     - Ask the user for permission before using \`send_code_to_revit\`.

6. **Parameter Sync Rule**
   - Always ensure that after a family is opened or edited, \`extract_family_params\` is called to keep the context updated.

---

## 💡 Behavioral Requirements

- Always explain your actions and confirm next steps with the user.
- If context is missing or ambiguous, ask clarifying questions.
- Never assume the user's intent when unsure.
- Always mention which tool you are using or planning to use next.
- Maintain a conversational tone, but keep reasoning concise and technical.

---

## 🧱 Context Notes

- Image URLs returned by \`pdf_path_to_images\` represent pages from the user's PDF.
  Treat them as input for visual context extraction, not as raw URLs.
- Family parameters from \`extract_family_params\` define the editable context for the current session.
- Tool responses are always authoritative — trust them when deciding your next step.

---

## 🧾 Output Format

- Be human-readable and clear.
- Explain reasoning: "I'll open a family matching your PDF description using the find_rfa and open_rfa tools."
- After tool use, summarize what was done and ask what to do next.
- If using Revit API code, show the code and ask: "Would you like me to run this?" before proceeding.

---

## ⚠️ Safety and Permissions

- Never use \`send_code_to_revit\` without user confirmation.
- Never overwrite or delete data silently.
- If a family cannot be found or opened, report the issue and suggest next steps.

---

In summary:
Act like a project-aware Revit engineer who autonomously sequences tools to fulfill user intent, maintains context between steps, and keeps the user informed throughout the process.`;

// Helper functions for LLM integration
function formatToolsForLLM(tools) {
  if (!tools || !Array.isArray(tools)) return [];
  
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || `Execute ${tool.name}`,
      parameters: validateAndCleanSchema(tool.inputSchema) || {
        type: "object",
        properties: {},
      },
    },
  }));
}

function validateAndCleanSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }

  const cleanSchema = { ...schema };

  if (!cleanSchema.type) {
    cleanSchema.type = "object";
  }

  if (!cleanSchema.properties) {
    cleanSchema.properties = {};
  }

  if (cleanSchema.properties && typeof cleanSchema.properties === "object") {
    cleanSchema.properties = cleanSchemaProperties(cleanSchema.properties);
  }

  if (cleanSchema.type === "array" && !cleanSchema.items) {
    cleanSchema.items = { type: "string" };
  }

  return cleanSchema;
}

function cleanSchemaProperties(properties) {
  const cleanProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "object") {
      cleanProperties[key] = validateAndCleanSchema(value);
    } else {
      cleanProperties[key] = value;
    }
  }
  return cleanProperties;
}

// OpenAI API endpoint
app.post('/api/chat/completions', async (req, res) => {
  try {
    const { messages, tools, model = 'gpt-5', stream = false, includeSystemPrompt = true } = req.body;

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'OpenAI API key not configured' });
    }
console.log(messages)
    // Prepare messages with system prompt if requested
    let finalMessages = messages;
    if (includeSystemPrompt && messages && messages.length > 0) {
      // Check if first message is already a system prompt
      const hasSystemPrompt = messages[0]?.role === 'system';
      if (!hasSystemPrompt) {
        finalMessages = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...messages
        ];
      }
    }

    // Format tools for OpenAI API
    const formattedTools = tools ? formatToolsForLLM(tools) : [];

    const requestBody = {
      model,
      messages: finalMessages,
      tools: formattedTools.length > 0 ? formattedTools : undefined,
      tool_choice: formattedTools.length > 0 ? 'auto' : undefined,
      max_completion_tokens: 4000,
      stream,
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

console.log(response);

    if (!response.ok) {
      const error = await response.json();
      return res.status(response.status).json(error);
    }

    if (!stream) {
      const data = await response.json();
      console.log(data)
      return res.json(data);
    }

    // Handle streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    response.body.pipe(res);

    req.on('close', () => {
      response.body.destroy();
    });

  } catch (error) {
    console.error('Error calling OpenAI API:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log(`OpenAI API key configured: ${process.env.OPENAI_API_KEY ? 'Yes' : 'No'}`);
});

