/**
 * @description Transcribe audio buffer via mlx_whisper (Apple Silicon, local).
 * OGG/OPUS inputs are converted to WAV via ffmpeg before transcription.
 */
import { exec } from 'child_process'
import { writeFile, rm } from 'fs/promises'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execAsync = promisify(exec)

const DEFAULT_MODEL = 'mlx-community/whisper-large-v3-turbo'

const OGG_EXTS = new Set(['ogg', 'opus', 'oga'])

export async function transcribeBuffer(buf: Buffer, ext: string, model = DEFAULT_MODEL): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), 'teya-voice-'))
  const inputPath = join(dir, `audio.${ext}`)
  let audioPath = inputPath

  try {
    await writeFile(inputPath, buf)

    if (OGG_EXTS.has(ext.toLowerCase())) {
      const wavPath = join(dir, 'audio.wav')
      await execAsync(`ffmpeg -i "${inputPath}" -ar 16000 -ac 1 "${wavPath}" -y`, { timeout: 30_000 })
      audioPath = wavPath
    }

    const script = `import mlx_whisper,os; r=mlx_whisper.transcribe(os.environ['AP'],path_or_hf_repo=os.environ['M']); print(r['text'])`
    const { stdout } = await execAsync(`python3 -c "${script}"`, {
      timeout: 120_000,
      env: { ...process.env, AP: audioPath, M: model },
    })
    return stdout.trim() || null
  } catch {
    return null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
