/**
 * @description Tool result truncation — head+tail with marker, never truncates errors
 */
export function truncateToolResult(result: string, maxChars: number = 5000): string {
  if (result.length <= maxChars) return result

  // Never truncate errors
  if (result.startsWith('Error:') || result.startsWith('error:')) return result.slice(0, maxChars * 2)

  const headBudget = Math.floor(maxChars * 0.6)
  const tailBudget = Math.floor(maxChars * 0.3)
  const head = result.slice(0, headBudget)
  const tail = result.slice(-tailBudget)
  return `${head}\n\n[...truncated, ${result.length} chars total...]\n\n${tail}`
}
