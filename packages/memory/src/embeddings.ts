/**
 * @description Embedding providers (Ollama, OpenAI) and cosine similarity
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
  dimensions: number
}

// Ollama embedding provider (local, free)
export function ollamaEmbeddings(config?: { model?: string; baseUrl?: string }): EmbeddingProvider {
  const model = config?.model || 'nomic-embed-text'
  const baseUrl = config?.baseUrl || 'http://localhost:11434'

  return {
    dimensions: 768,

    async embed(text: string): Promise<number[]> {
      const response = await fetch(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: text }),
      })
      if (!response.ok) throw new Error(`Ollama embed error: ${response.status}`)
      const data = await response.json() as { embeddings: number[][] }
      return data.embeddings[0]
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      const response = await fetch(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
      })
      if (!response.ok) throw new Error(`Ollama embed error: ${response.status}`)
      const data = await response.json() as { embeddings: number[][] }
      return data.embeddings
    },
  }
}

// OpenAI embedding provider
export function openaiEmbeddings(config: { apiKey: string; model?: string }): EmbeddingProvider {
  const model = config.model || 'text-embedding-3-small'

  return {
    dimensions: 1536,

    async embed(text: string): Promise<number[]> {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model, input: text }),
      })
      if (!response.ok) throw new Error(`OpenAI embed error: ${response.status}`)
      const data = await response.json() as { data: Array<{ embedding: number[] }> }
      return data.data[0].embedding
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model, input: texts }),
      })
      if (!response.ok) throw new Error(`OpenAI embed error: ${response.status}`)
      const data = await response.json() as { data: Array<{ embedding: number[] }> }
      return data.data.map(d => d.embedding)
    },
  }
}

// Cosine similarity between two vectors
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dotProduct = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dotProduct / denom
}
