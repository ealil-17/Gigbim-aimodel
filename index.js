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

**IMPORTANT NOTE ABOUT PDF FILES:**
When a user uploads a PDF, the images are ALREADY CONVERTED on the client side and provided as base64 images in the conversation context.

1. **find_image_rfa**
   - Searches the RFA library using visual content from base64-encoded images.
   - Use this when the user uploads a PDF/image and asks to "find" or "search" for matching RFA files.
   - When a PDF is uploaded, the images are automatically available. You can call find_image_rfa without providing image_base64 - the system will automatically use the uploaded images.
   - If you need to provide specific images, use the image_base64 parameter with base64-encoded image strings.
   - Example: User uploads PDF and says "find this" → simply call find_image_rfa (images are auto-injected).

2. **find_rfa**
   - Searches the Revit library using text-based RAG to find families that match a natural-language description.
   - Returns the best matching RFA file (single result).
   - Use this when the user provides TEXT descriptions like:
     - "Find a family of window."
     - "Search for a door family."
     - "Find a water tank"

3. **open_rfa**
   - Opens a specific Revit Family (.rfa) file using its full file path.
   - Usually used after find_rfa or find_image_rfa returns results.
   - Use this when the user says things like:
     - "Open option 2."
     - "Open the third family."
     - "Use that family."
   - Or when the exact RFA file path is already known.

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

1. **PDF Information Extraction Flow** (user asks "describe", "analyze", "what is")
   - The system AUTOMATICALLY uploads PDF images to S3.
   - You receive image URLs in the conversation.
   - Analyze the images and extract information: dimensions, parameters, materials, metadata.
   - Present the extracted information to the user.
   - DO NOT call pdf_path_to_images - this is handled automatically.

2. **PDF Visual Search Flow** (user asks "find", "search", "match")
   - When a PDF is uploaded, base64 images are provided in the conversation context.
   - You should call find_image_rfa with the base64 images from the conversation.
   - Present the search results to the user.
   - If the user wants to open one, use open_rfa with the selected file path.

3. **Text-Based Search Flow**
   - If the user provides a TEXT description (like "find a door family"), use \`find_rfa\`.
   - After getting results, present them and ask which one to open.
   - Use \`open_rfa\` to open the selected family.
   - After opening, use \`extract_family_params\` to get context.

4. **Direct Edit Flow**
   - If the user directly requests a modification of the current family (e.g., "change width to 2500 mm"):
     - If parameters are not in context, first use \`extract_family_params\`.
     - Then call \`family_editor\`.
     - After the edit, confirm completion and ask if the user wants to save and load.

5. **Post-Edit Flow**
   - After any family edit, always ask:
     "Would you like to save and load this family into your project or continue editing?"
   - If the user says yes, use \`save_and_load_family\`.

6. **Fallback / Creative Flow**
   - When none of the above tools can achieve the user's request:
     - Generate the appropriate Revit API code.
     - Ask the user for permission before using \`send_code_to_revit\`.

6. **Parameter Sync Rule**
   - Always ensure that after a family is opened or edited, \`extract_family_params\` is called to keep the context updated.

---

## 💡 Behavioral Requirements

- Always explain your actions and confirm next steps with the user.
- If context is missing or ambiguous, ask clarifying questions.
- Never assume the user’s intent when unsure.
- Always mention which tool you are using or planning to use next.
- Maintain a conversational tone, but keep reasoning concise and technical.

---

## 🧱 Context Notes

- Image URLs returned by \`pdf_path_to_images\` represent pages from the user’s PDF.
  Treat them as input for visual context extraction, not as raw URLs.
- Family parameters from \`extract_family_params\` define the editable context for the current session.
- Tool responses are always authoritative — trust them when deciding your next step.

---

## 🧾 Output Format

- Be human-readable and clear.
- Explain reasoning: “I’ll open a family matching your PDF description using the find_rfa and open_rfa tools.”
- After tool use, summarize what was done and ask what to do next.
- If using Revit API code, show the code and ask: “Would you like me to run this?” before proceeding.

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

    // Validate JWT token
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No authorization token provided' });
    }

    // Extract token (remove "Bearer " if present)
    const token = authHeader.replace(/^Bearer\s+/i, '');

    const authServiceUrl = 'https://api-revit-backend.yokostyles.com'; //http://host.docker.internal:3000 //http://localhost:3000 //https://api-revit-backend.yokostyles.com
    try {
      console.log('Validating token with auth service...');
      const validationResponse = await fetch(`${authServiceUrl}/api/auth/validate`, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ token })
      });

      if (!validationResponse.ok) {
        console.error('Auth service returned error status:', validationResponse.status);
        return res.status(401).json({ error: 'Token validation request failed' });
      }

      const validationData = await validationResponse.json();
      console.log('Validation response:', validationData);

      if (!validationData.isValid) {
        return res.status(401).json({ error: 'Invalid token' });
      }

      if (!validationData.isFreeTrial) {
        return res.status(403).json({ error: 'Subscription required (Free trial expired or not active)' });
      }

      // Token is valid and free trial is active, proceed
    } catch (error) {
      console.error('Authentication service error:', error);
      return res.status(500).json({ error: 'Authentication check failed' });
    }

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

