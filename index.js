// Filename: code_assistant.js

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { OpenAI } = require('openai');

// Load environment variables from .env file
require('dotenv').config();

// Convert exec to return a promise
const execAsync = promisify(exec);

async function cloneRepo(repoUrl, localPath) {
    try {
        await execAsync(`git clone ${repoUrl} ${localPath}`);
        console.log(`Repository cloned to ${localPath}`);
    } catch (error) {
        console.error(`Error cloning repository: ${error}`);
    }
}

function readCodeFiles(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(function(file) {
        file = path.resolve(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            // Recurse into subdirectories
            results = results.concat(readCodeFiles(file));
        } else {
            // Only include code files
            const ext = path.extname(file);
            const codeExtensions = ['.js', '.ts', '.py', '.java', '.c', '.cpp', '.go', '.rb', '.php', '.md'];
            if (codeExtensions.includes(ext)) {
                // Read file content
                const content = fs.readFileSync(file, 'utf8');
                results.push({ path: file, content: content });
            }
        }
    });
    return results;
}

// Initialize OpenAI API client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

async function generateEmbedding(text) {
    try {
        const response = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: text,
        });
        return response.data[0].embedding;
    } catch (error) {
        console.error(`Error generating embedding: ${error.response ? error.response.data : error.message}`);
    }
}

async function generateEmbeddingsForCodeFiles(codeFiles) {
    const promises = codeFiles.map(async (file) => {
        try {
            // Truncate content if too long
            const maxLength = 8000; // adjust as needed
            let content = file.content;
            if (content.length > maxLength) {
                content = content.substring(0, maxLength);
            }
            const embedding = await generateEmbedding(content);
            file.embedding = embedding;
        } catch (error) {
            console.error(`Error generating embedding for file ${file.path}: ${error}`);
        }
    });
    await Promise.all(promises);
}

function cosineSimilarity(vecA, vecB) {
    let dotProduct = 0.0;
    let normA = 0.0;
    let normB = 0.0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function main() {
    const localPath = './temp_repo'; // Local directory to clone to

    // Ask user for repo URL
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question('Enter the GitHub repository URL to clone: ', async (inputRepoUrl) => {
        const repoUrl = inputRepoUrl.trim();
        await cloneRepo(repoUrl, localPath);

        const codeFiles = readCodeFiles(localPath);

        console.log(`Generating embeddings for ${codeFiles.length} code files...`);
        await generateEmbeddingsForCodeFiles(codeFiles);

        rl.question('What is your question about the code? ', async (question) => {
            console.log(`Processing your question...`);

            const questionEmbedding = await generateEmbedding(question);

            codeFiles.forEach((file) => {
                if (file.embedding) {
                    file.similarity = cosineSimilarity(questionEmbedding, file.embedding);
                } else {
                    file.similarity = -1;
                }
            });

            // Sort code files by similarity
            codeFiles.sort((a, b) => b.similarity - a.similarity);

            // Select top N files
            const topN = 100; // adjust as needed
            const relevantFiles = codeFiles.slice(0, topN);

            // Construct the messages for the chat completion
            let systemMessage = `You are an expert programmer. Here are some code files:`;

            let userMessage = ``;

            const maxFileContentLength = 5000; // Limit content to prevent exceeding token limits
            relevantFiles.forEach((file) => {
                let content = file.content;
                if (content.length > maxFileContentLength) {
                    content = content.substring(0, maxFileContentLength);
                }
                userMessage += `File: ${path.relative(localPath, file.path)}\n`;
                userMessage += `\`\`\`\n${content}\n\`\`\`\n\n`;
            });

            userMessage += `Respond to the follow about the code above:\n\n${question}`;

            console.log('Sending request to OpenAI API...');

            try {
                const response = await openai.chat.completions.create({
                    model: "o1-mini", // Updated model name
                    messages: [
                        { role: 'user', content: `${systemMessage} ${userMessage}` }
                    ],
                });

                console.log('Response from OpenAI:');
                console.log(response.choices[0].message.content);
            } catch (error) {
                console.error(`Error calling OpenAI API: ${error.response ? JSON.stringify(error.response.data, null, 2) : error.message}`);
            }

            // Clean up: remove the cloned repository
            fs.rmSync(localPath, { recursive: true, force: true });

            rl.close();
        });
    });
}

main();
