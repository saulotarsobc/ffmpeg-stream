import dotenv from "dotenv";
dotenv.config();

import cliProgress from "cli-progress";
import ffmpeg from "fluent-ffmpeg";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { bucket } from "./bucket";

const curso = "mysql";
const aula = "aula-1";
const inputFile = join(__dirname, "..", "videos", curso, `${aula}.mp4`);
const outputDir = join(__dirname, "..", "temp", curso, aula);
const server = "http://192.168.1.181:3000";
const hls_time = 10;
const hls_list_size = 0;
const bucketName = "videos";
const resolutions = ["low", "medium", "high", "full"];

type resolutionType = {
  width: number;
  height: number;
};

const progressBars = new cliProgress.MultiBar(
  {
    clearOnComplete: true,
    hideCursor: true,
    format:
      "{name} [{bar}] | {percentage}%/{total} | frames:{frames} | fps:{currentFps} | {timemark}",
  },
  cliProgress.Presets.shades_classic
);

// Inicializar barras de progresso para cada resolução
const progressBar = progressBars.create(100, 0, {
  name: "Progresso",
  percentage: 0,
  timemark: "00:00:00",
  currentFps: 0,
});

// Função para limpar o diretório de saída
const clearOutputDir = (dir: string): void => {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
};

// Criação dos diretórios de resoluções
const createResolutionDirs = (baseDir: string, resolutions: string[]): void => {
  resolutions.forEach((res: string) => {
    const dir = join(baseDir, res);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  });
};

/**
 * Cria um arquivo de streaming HLS com base em um vídeo de entrada.
 * @param {string} input - Caminho do arquivo de vídeo de entrada.
 * @param {resolutionType} resolution - Resolução do vídeo de saída.
 * @param {string} bitrate - Taxa de bits do áudio.
 * @param {string} outputPath - Caminho do diretório de saída do arquivo HLS.
 * @param {string} baseUrl - URL base para os arquivos de segmento do HLS.
 * @returns {void} - Promessa que resolve quando o processo terminar.
 */
function createHLS(
  input: string,
  resolution: resolutionType,
  bitrate: string,
  outputPath: string,
  baseUrl: string
): Promise<void> {
  return new Promise((resolve, reject): void => {
    ffmpeg(input)
      .outputOptions([
        `-vf scale=w=${resolution.width}:h=${resolution.height}:force_original_aspect_ratio=decrease`, // Usa escala padrão na CPU
        `-c:v h264_nvenc`, // Usa NVENC (GPU) para codificação de vídeo
        `-preset slow`, // Define o preset rápido para teste
        `-cq:v 23`, // Qualidade constante padrão para NVENC
        `-c:a aac`, // Codificação de áudio AAC
        `-b:a ${bitrate}`, // Bitrate do áudio
        `-hls_time ${hls_time}`, // Duração dos segmentos HLS
        `-hls_list_size ${hls_list_size}`, // Tamanho da lista de segmentos
        `-hls_playlist_type vod`, // Define o tipo de playlist HLS
        `-hls_base_url ${baseUrl}`, // URL base dos segmentos HLS
        `-hls_segment_filename ${join(outputPath, "%03d.ts")}`, // Formato do nome dos segmentos
      ])
      .output(join(outputPath, "master.m3u8"))
      .on("progress", (progress) => {
        progressBar.update(progress.percent || 0, {
          percentage: progress.percent?.toFixed(2) || 0,
          timemark: progress.timemark,
          frames: progress.frames || 0,
          total: 100,
          currentFps: progress.currentFps || 0,
        });
      })
      .on("start", (commandLine) => {
        console.log("\nComando FFmpeg:\n", commandLine, "\n\n");
      })
      .on("end", () => {
        console.log(
          `\nResolução ${resolution.width}x${resolution.height}: 100%`
        );
        resolve();
      })
      .on("error", () => reject())
      .run();
  });
}

/**
 *
 * @param bucketName
 * @param filePath
 * @param key
 */
const uploadFile = async (
  bucketName: string,
  filePath: string,
  key: string
) => {
  try {
    await bucket.fPutObject(bucketName, key, filePath, {});
    console.log(`Arquivo enviado com sucesso: ${key}`);
  } catch (err) {
    console.error(`Erro ao enviar ${key}:`, err.message);
  }
};

// Função principal
(async () => {
  clearOutputDir(outputDir);
  // createResolutionDirs(outputDir, resolutions);
  createResolutionDirs(outputDir, resolutions);

  try {
    await Promise.all([
      createHLS(
        inputFile,
        { width: 426, height: 360 },
        "96k",
        `${outputDir}/low`,
        `${server}/segment/${curso}/${aula}/low/`
      ),
      createHLS(
        inputFile,
        { width: 640, height: 480 },
        "128k",
        `${outputDir}/medium`,
        `${server}/segment/${curso}/${aula}/medium/`
      ),
      createHLS(
        inputFile,
        { width: 854, height: 720 },
        "160k",
        `${outputDir}/high`,
        `${server}/segment/${curso}/${aula}/high/`
      ),
      createHLS(
        inputFile,
        { width: 1920, height: 1080 },
        "192k",
        `${outputDir}/full`,
        `${server}/segment/${curso}/${aula}/full/`
      ),
    ]).then(() => {
      console.log("Arquivos HLS criados com sucesso");
    });

    // Criação do master playlist
    const masterPlaylist = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x360
${server}/resolution/${curso}/${aula}/low/
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x480
${server}/resolution/${curso}/${aula}/medium/
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x720
${server}/resolution/${curso}/${aula}/high/
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080
${server}/resolution/${curso}/${aula}/full/
`;

    writeFileSync(join(outputDir, "master.m3u8"), masterPlaylist, "utf-8");

    // enviar arquivo master
    uploadFile(
      bucketName,
      join(outputDir, "master.m3u8"),
      `${curso}/${aula}/master.m3u8`
    )
      .then(() => {
        console.log("Master playlist enviada com sucesso");
      })
      .catch((err) => console.error(`Erro ao enviar master:`, err.message));

    // enviar resulucoes
    for (const resolution of resolutions) {
      uploadFile(
        bucketName,
        join(outputDir, resolution, "master.m3u8"),
        `${curso}/${aula}/${resolution}/master.m3u8`
      )
        .then(() => {
          console.log(`Resolução ${resolution} enviada com sucesso`);
        })
        .catch((err) =>
          console.error(`Erro ao enviar ${resolution}:`, err.message)
        );

      // listar todos os segmentos em cada diretorio de resolução
      const segments = readdirSync(join(outputDir, resolution)).filter((file) =>
        file.endsWith(".ts")
      );

      for (const segment of segments) {
        uploadFile(
          bucketName,
          join(outputDir, resolution, segment),
          `${curso}/${aula}/${resolution}/${segment}`
        )
          .then(() => {
            console.log(`Segmento ${segment} enviado com sucesso`);
          })
          .catch((err) =>
            console.error(`Erro ao enviar ${segment}:`, err.message)
          );
      }
    }
  } catch (error) {
    console.error("Erro durante a conversão:", error);
  }
})();
