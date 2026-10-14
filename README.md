# 🏍️ Fábrica de Shorts con IA en n8n

Un workflow de n8n que hace un **YouTube Short de principio a fin, solo**: elige un tema que no hayas hecho, escribe el guion y el storyboard con IA, genera 3 tomas de video, le pone voz y subtítulos, y lo sube a YouTube (y a TikTok, si querés).

- **Costo por video:** menos de **$0.40** (≈ $0.36 de video + ≈ $0.01 de voz en Kie).
- **Salida:** 720×1280, ~28 s, voz en español con subtítulos quemados.
- **Plantilla:** canal de motos, pero cambiás la lista de temas y el prompt del director y sirve para cualquier nicho.

📺 **Tutorial completo (8 min):** https://youtu.be/xv_s1UJoszE

## Qué hay en el repo
| Archivo | Para qué |
|---|---|
| `workflow/fabrica-shorts-motos.json` | El workflow. Importalo en n8n (menú ⋯ → *Import from file*). |
| `tools/burn.js` | Mezcla la voz sobre el video y quema los subtítulos (ffmpeg). |
| `tools/tiktok_post.js` | Opcional: publica en TikTok con la Content Posting API. |
| `docker-compose.example.yml` | n8n con las carpetas y permisos que necesita la fábrica. |

## Cómo funciona (7 etapas)
1. **Disparo:** a mano o cada 4 días a las 11:00.
2. **Verificar canal:** si la credencial de YouTube no es de tu canal, frena **antes de gastar**.
3. **Brief:** categoría y formato al azar, sin repetir lo que ya está en tu historial.
4. **Director de Cine (IA):** propone 5 temas, elige uno, escribe título, descripción, hashtags, narración y un storyboard de 3 tomas (Ollama cloud, con respaldo gratis de OpenRouter). *Validar Nuevo* corta si el tema se parece a uno ya hecho.
5. **Tomas de video:** 3 × 10 s con Grok Imagine 480p en Kie (se usan 9.4 s de cada una) y se unen con ffmpeg.
6. **Voz y montaje:** Gemini 2.5 Pro TTS en Kie + `burn.js` (subtítulos de 3–4 palabras).
7. **Publicar:** YouTube (y TikTok opcional) y registra el ID en el historial.

## Instalación
### 1. n8n
```bash
git clone https://github.com/devlewiso/n8n-fabrica-shorts && cd n8n-fabrica-shorts
cp docker-compose.example.yml docker-compose.yml
mkdir -p videos/final tools/fonts
```
### 2. ffmpeg y la fuente de los subtítulos
`burn.js` espera `ffmpeg` y `ffprobe` en `/opt/tools` y una fuente en `/opt/tools/fonts`:
```bash
# ffmpeg estático (Linux x86_64)
curl -L https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz | tar xJ --strip-components=1 -C tools --wildcards '*/ffmpeg' '*/ffprobe'
# Liberation Sans Bold (licencia libre)
curl -L -o tools/fonts/LiberationSans-Bold.ttf https://github.com/liberationfonts/liberation-fonts/raw/main/src/LiberationSans-Bold.ttf
docker compose up -d
```
> Si ya tenés n8n: montá `tools/` en `/opt/tools`, una carpeta en `/files`, y habilitá el nodo **Execute Command** (`NODES_EXCLUDE=["n8n-nodes-base.localFileTrigger"]`).

### 3. Credenciales en n8n
| Credencial | Tipo | Cómo |
|---|---|---|
| **Kie.ai (Header Auth)** | Header Auth | Name `Authorization`, Value `Bearer TU_API_KEY`. Creá tu cuenta en [kie.ai](https://kie.ai?ref=538b343ce64a7b9e5823c3b8ad471121) ¹ |
| **Ollama** | Ollama API | Para el guion (modelos `:cloud`). Podés cambiarlo por cualquier modelo de chat. |
| **OpenRouter** | OpenRouter API | Respaldo gratis del guion. |
| **YouTube (OAuth2)** | YouTube OAuth2 API | Con el canal donde vas a subir. |

¹ _Link de afiliado: si te registrás con él me llega una pequeña comisión, sin costo extra para vos._

### 4. Data Table del historial
En n8n → **Data tables**, creá una tabla (por ejemplo `motos_historial`) con estas columnas, todas de texto:
`fecha, tema, titulo, categoria, formato, dato_central, costo_usd, modelo, youtube_id`

Elegila en los nodos **Leer Historial**, **Guardar Historial** y **Registrar Subida**.

### 5. Configuración
Abrí el nodo **⚙️ Configuración**:
| Campo | Ejemplo |
|---|---|
| `canal_youtube` | `micanal` (sin @). Vacío = no verifica. |
| `voz` | `Charon`, `Fenrir`, `Puck`, `Kore`, `Aoede`… |
| `idioma` / `region_youtube` | `es` / `MX` |
| `privacidad` | `public`, `unlisted` o `private` (recomendado para la primera prueba) |
| `texto_extra_descripcion` | Tus redes o tus links |

Corré con **Execute workflow**. La primera vez poné `privacidad = private` y revisá el video en YouTube Studio.

### 6. TikTok (opcional)
Los nodos de TikTok vienen **desactivados**. Para usarlos: creá una app en TikTok for Developers (Content Posting API), guardá `app.json` (`client_key`, `client_secret`) y `token.json` (OAuth) en `tools/tiktok/` y activá *Preparar TikTok*, *Publicar TikTok* y *Resultado TikTok*.

## Adaptarlo a tu nicho
- **Preparar Brief:** cambiá las listas `CENTRO` y `GENERAL` por tus temas.
- **Director de Cine (motos):** cambiá el prompt (público, tono, qué evitar).
- **Modelo de video:** en *Crear Toma (Kie)* podés pasar a 720p o a otro modelo de Kie (ver la nota *Modelos* dentro del workflow).

## Problemas comunes
- **«La credencial de YouTube no es del canal…»:** la credencial OAuth es de otra cuenta, o `canal_youtube` tiene un typo.
- **Execute Command no aparece:** falta `NODES_EXCLUDE` (n8n 2.x lo apaga por defecto).
- **«no existe la narración»:** revisá que `/files` esté montado y se pueda escribir.

## Licencia
MIT. Los videos que generes son tuyos; revisá los términos de cada proveedor (Kie, YouTube, TikTok).
