<?php
/**
 * config.php — Configuración de «Team Room»
 *
 * Este archivo NO imprime nada: solo devuelve un arreglo. Si alguien lo abre
 * directamente en el navegador, responde 403.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DÓNDE PONER LOS SECRETOS (de más a menos recomendado)
 *   1. Un archivo `.env` en la carpeta HOME de cPanel, por encima de public_html
 *      (por ejemplo /home/tuusuario/.env). No es accesible desde la web.
 *   2. Un archivo `.env` junto a este config.php (bloquéalo con el .htaccess de abajo).
 *   3. Editar directamente los valores por defecto de este archivo.
 *
 * Contenido de ejemplo del .env:
 *   APP_PASSWORD=una-clave-larga-y-unica
 *   GEMINI_API_KEY=AIza...
 *   GEMINI_MODEL=gemini-3.8-flash
 *   ROOM_MODE=sequential        # sequential (cada agente ve lo que dijeron los anteriores) | parallel
 *   ROOM_YIELD_MODE=llm         # llm | canned (canned no gasta cuota: cede el turno sin llamar a Gemini)
 *   ROOM_DEFAULT=general        # id de la habitación que se abre por defecto (opcional)
 *
 * APP_PASSWORD también acepta un hash generado con:
 *   php -r "echo password_hash('tu-clave', PASSWORD_DEFAULT);"
 *
 * .htaccess recomendado en la carpeta de la app (incluido como archivo en este paquete):
 *   <FilesMatch "^(\.env|config\.php|error_log|.*\.log)$">
 *       Require all denied
 *   </FilesMatch>
 *   <IfModule mod_autoindex.c>
 *       Options -Indexes
 *   </IfModule>
 *   La carpeta _tests/ no debería subirse nunca al hosting; si ya está ahí, bórrala
 *   (lleva su propio .htaccess de respaldo, pero borrarla es lo correcto).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HABITACIONES (salas / presets de agentes)
 *   Cada habitación es un archivo en la carpeta `rooms/` que devuelve su conjunto de
 *   agentes (nombre, rol, avatar, alias y System Prompt). La interfaz las lista en
 *   el selector «Habitación» y no tiene nada fijo en el código: para agregar una sala
 *   (Emprendimiento/Freelance, Lógica de videojuegos, Tutoría académica...) basta con
 *   copiar rooms/general.php, cambiar su contenido y guardar. No hay que tocar
 *   api.php, app.js ni index.html.
 *
 *   Campos de una habitación:
 *     id, name, description       identificador (sin espacios), nombre y descripción del selector
 *     order                       posición en el selector (menor = antes; por defecto 100)
 *     default                     true en la habitación que se abre por defecto
 *     mode                        'sequential' | 'parallel' | omitido (usa ROOM_MODE). En «sequential»
 *                                 cada agente ve lo que dijeron los anteriores en la misma ronda.
 *     intro                       primer párrafo del prompt común (quién es cada agente en esta sala);
 *                                 se le añaden las reglas comunes de sala_common_rules().
 *                                 (O bien `shared_prompt` con el texto completo.)
 *     grid                        orden de los agentes en la cuadrícula 2 x 2, por filas
 *     agents[]                    id, name, role, tagline, accent (blue|magenta|yellow|green), icon,
 *                                 aliases, avatar (mapa emoción => archivo), greeting, starters,
 *                                 system_prompt, temperature (opcional)
 *
 *   También se cargan habitaciones en JSON (`templates/<id>.json`) con la misma forma.
 *   Emociones del avatar: neutral, happy, thinking, shock, angry (neutral es obligatoria).
 *   Íconos de respaldo: code, layout, server, database, cloud, scale, megaphone, bulb, pen, chart, shield, bot.
 *   Marcadores útiles dentro de los prompts: {{agent_name}}, {{template_name}}, {{roster}}.
 *
 *   Los System Prompts viven SOLO en el servidor: el navegador envía el id de la habitación y del
 *   agente, y api.php arma el prompt. Así nadie puede usar tu API Key con prompts propios.
 */

if (!defined('SALA_BOOT')) {
    http_response_code(403);
    exit('Acceso denegado.');
}

/**
 * Lee una variable: entorno real > .env (HOME de cPanel) > .env local > valor por defecto.
 */
function sala_env(string $key, ?string $default = null): ?string
{
    static $fileVars = null;

    if ($fileVars === null) {
        $fileVars = [];
        $candidates = [];
        if (!empty($_SERVER['DOCUMENT_ROOT'])) {
            $candidates[] = dirname(rtrim((string) $_SERVER['DOCUMENT_ROOT'], '/\\')) . '/.env';
        }
        $candidates[] = __DIR__ . '/.env';

        foreach ($candidates as $path) {
            if (!is_readable($path)) {
                continue;
            }
            foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
                $line = trim($line);
                if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) {
                    continue;
                }
                [$name, $value] = array_map('trim', explode('=', $line, 2));
                if ($value !== '' && ($value[0] === '"' || $value[0] === "'")) {
                    $value = preg_match('/^(["\'])(.*?)\1/', $value, $q) ? $q[2] : trim($value, "\"'");
                } else {
                    $value = trim(preg_replace('/\s+#.*$/', '', $value)); // comentario al final de la línea
                }
                if ($name !== '' && !isset($fileVars[$name])) {
                    $fileVars[$name] = $value;
                }
            }
        }
    }

    $real = getenv($key);
    if ($real !== false && $real !== '') {
        return $real;
    }
    return $fileVars[$key] ?? $default;
}

/** Emociones que puede devolver un agente (y que puede tener su avatar). */
function sala_emotions(): array
{
    return ['neutral', 'happy', 'thinking', 'shock', 'angry'];
}

/**
 * Arma el mapa emoción => archivo para una carpeta de avatares con nombres
 * del tipo {prefijo}{emoción}.svg. `$names` permite variantes (p. ej. shock => shocked).
 */
function sala_avatar_map(string $dir, string $prefix, array $names = []): array
{
    $map = [];
    foreach (sala_emotions() as $emotion) {
        $map[$emotion] = $dir . '/' . $prefix . ($names[$emotion] ?? $emotion) . '.svg';
    }
    return $map;
}

/**
 * Reglas comunes a todas las habitaciones (brevedad, calidad, imágenes y formato de emoción).
 * Cada habitación aporta su propia introducción (quién es cada agente en esa sala).
 */
function sala_common_rules(): string
{
    return <<<'PROMPT'
CÓMO CONVERSAS
- Habla como una persona con criterio y personalidad, no como un asistente de servicio: opina, explica el porqué (con una analogía o un ejemplo si ayuda), cuestiona con respeto las ideas flojas, propone alternativas y, cuando conviene, cierra con UNA pregunta que haga avanzar la charla.
- No puedes construir, desplegar, configurar ni acceder a nada fuera de este chat (tampoco a internet), así que no digas que vas a hacerlo ni que «estás preparado para hacerlo». Evita el tono de servicio: nada de «voy a diseñar...», «quedo a la espera de tus requerimientos», «estoy listo para...» ni «¿en qué puedo ayudarte?». Guía con lo que sabes: «yo lo haría así...», «prueben esto...», «ojo con...».
- Ante un saludo o un mensaje suelto, responde como lo haría tu personalidad con un amigo, en una o dos frases, sin ofrecer servicios.
- Brevedad: en la parte conversacional responde con alrededor de 75 palabras como máximo, directo y sin relleno. Solo te extiendes si te piden de forma explícita una explicación detallada.
- Responde en el idioma del usuario (español por defecto). Usa Markdown ligero.
- Si falta información imprescindible, haz UNA pregunta concreta en lugar de suponer demasiado.
- Si el tema le corresponde a otro agente, dilo en una línea y sugiere qué preguntarle. Puedes apoyarte en lo que ya dijeron los demás (te lo indica el contexto de la sala) sin repetirlo.
- No inventes datos, cifras, versiones, fuentes ni opciones de configuración: si no estás seguro, dilo.
- Nunca pidas ni repitas contraseñas, tokens o claves API.

IMÁGENES
- Si el mensaje incluye una imagen (captura, diagrama, interfaz, documento, foto), analízala desde tu especialidad: comenta lo que ves y que sea relevante para tu rol, sin inventar detalles que no se distingan; si algo no se ve con claridad, dilo. Los demás agentes ven la misma imagen, así que no la describas entera: aporta tu ángulo.
- Si la imagen muestra claves, tokens o datos personales, avísalo.

REGLA DE ORO: LA PERSONALIDAD NUNCA REDUCE LA CALIDAD
- Tu personalidad vive en el tono: cómo saludas, cómo presentas lo que entregas y tus comentarios antes y después. Cambia el tono, jamás el trabajo.
- Cuando te pidan un prompt o código, entrégalo con tu estilo (un «aquí lo tienes» contento, gruñón, melancólico o sereno, según tu personalidad), pero lo entregado debe tener siempre la mejor calidad posible: completo, correcto, claro y sin rastro de tu humor. Dentro del bloque no hay bromas, quejas ni dramatismo, solo comentarios técnicos neutros.
- Un prompt para su editor o IA de código va en un bloque de código y es autocontenido: contexto del proyecto, stack, objetivo, requisitos, restricciones, criterios de aceptación, formato de salida esperado y qué NO debe hacer.
- El código va en un bloque con su lenguaje y debe ser correcto, seguro, idiomático y listo para pegar. Antes de entregarlo, revisa mentalmente que funcione: imports, casos límite básicos, validaciones. Si depende de un supuesto, dilo en una línea fuera del bloque.
- El límite de las 75 palabras aplica a tu conversación, NO al prompt ni al código que entregas: esos miden lo que necesiten para estar bien hechos. Si el pedido es enorme (una aplicación completa), entrega el esqueleto clave y ofrece armar un prompt para su editor.

FORMATO OBLIGATORIO
La PRIMERA línea de tu respuesta debe ser exactamente [[emocion: X]], donde X es una de: neutral, happy, thinking, shock, angry. Elígela según tu personalidad (abajo te digo cuáles te salen más) y la situación. Después de esa línea escribe tu respuesta. La aplicación lee esa etiqueta y no se la muestra al usuario.
PROMPT;
}

/** Prompt común completo de una habitación: su introducción + las reglas comunes. */
function sala_shared_prompt(string $intro): string
{
    return trim($intro) . "\n\n" . sala_common_rules();
}

/**
 * Valida y rellena valores por defecto de una plantilla. Devuelve null si es inválida.
 */
function sala_normalize_template(string $id, array $tpl): ?array
{
    if (empty($tpl['agents']) || !is_array($tpl['agents'])) {
        return null;
    }

    $emotions = sala_emotions();
    $agents = [];
    $seen = [];

    foreach ($tpl['agents'] as $a) {
        if (!is_array($a)) {
            continue;
        }
        $agentId = strtolower((string) ($a['id'] ?? ''));
        $prompt = trim((string) ($a['system_prompt'] ?? ''));
        if (!preg_match('/^[a-z0-9_-]{1,32}$/', $agentId) || $prompt === '' || isset($seen[$agentId])) {
            error_log("[sala] agente inválido o repetido en la plantilla «{$id}»: {$agentId}");
            continue;
        }
        $seen[$agentId] = true;

        // Avatares: solo rutas relativas dentro de la app y que existan.
        $avatar = [];
        foreach ((array) ($a['avatar'] ?? []) as $emotion => $path) {
            if (!in_array($emotion, $emotions, true) || !is_string($path)) {
                continue;
            }
            $valid = preg_match('#^[A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:svg|png|webp|gif|jpe?g)$#', $path)
                && !str_contains($path, '..');
            if (!$valid || !is_file(__DIR__ . '/' . $path)) {
                error_log("[sala] avatar no disponible ({$agentId}/{$emotion}): {$path}");
                continue;
            }
            $avatar[$emotion] = $path;
        }
        if (!isset($avatar['neutral'])) {
            $avatar = []; // sin avatar completo: la UI usa el ícono
        }

        $accent = strtolower((string) ($a['accent'] ?? ''));
        $aliases = array_values(array_filter((array) ($a['aliases'] ?? []), 'is_string'));
        $starters = array_values(array_filter((array) ($a['starters'] ?? []), 'is_string'));

        $agents[] = [
            'id' => $agentId,
            'name' => trim((string) ($a['name'] ?? $agentId)),
            'role' => trim((string) ($a['role'] ?? '')),
            'tagline' => trim((string) ($a['tagline'] ?? '')),
            'accent' => preg_match('/^[a-z]{3,12}$/', $accent) ? $accent : '',
            'icon' => (string) ($a['icon'] ?? 'bot'),
            'aliases' => array_slice($aliases, 0, 12),
            'avatar' => $avatar,
            'greeting' => trim((string) ($a['greeting'] ?? '')),
            'starters' => array_slice($starters, 0, 6),
            'system_prompt' => $prompt,
            'temperature' => isset($a['temperature']) ? max(0.0, min(2.0, (float) $a['temperature'])) : null,
        ];
    }

    if (!$agents) {
        return null;
    }

    // Orden en la cuadrícula: lo indicado en "grid" y, al final, los agentes que falten.
    $grid = [];
    foreach ((array) ($tpl['grid'] ?? []) as $gridId) {
        if (is_string($gridId) && isset($seen[$gridId]) && !in_array($gridId, $grid, true)) {
            $grid[] = $gridId;
        }
    }
    foreach ($agents as $agent) {
        if (!in_array($agent['id'], $grid, true)) {
            $grid[] = $agent['id'];
        }
    }

    // Prompt común: el texto completo (shared_prompt) o una introducción + las reglas comunes.
    $shared = trim((string) ($tpl['shared_prompt'] ?? ''));
    if ($shared === '' && trim((string) ($tpl['intro'] ?? '')) !== '') {
        $shared = (($tpl['common_rules'] ?? true) === false)
            ? trim((string) $tpl['intro'])
            : sala_shared_prompt((string) $tpl['intro']);
    }

    $mode = $tpl['mode'] ?? null;

    return [
        'id' => $id,
        'name' => trim((string) ($tpl['name'] ?? $id)),
        'description' => trim((string) ($tpl['description'] ?? '')),
        'order' => (int) ($tpl['order'] ?? 100),
        'default' => !empty($tpl['default']),
        'mode' => in_array($mode, ['sequential', 'parallel'], true) ? $mode : null,
        'shared_prompt' => $shared,
        'grid' => $grid,
        'agents' => $agents,
    ];
}

/**
 * Carga las habitaciones: rooms/*.php (recomendado) y templates/*.json.
 */
function sala_load_templates(): array
{
    $raw = [];

    foreach (glob(__DIR__ . '/rooms/*.php') ?: [] as $file) {
        // Una habitación con errores no debe tumbar la aplicación: se omite y se registra.
        try {
            $room = (static function (string $file) {
                return require $file;
            })($file);
        } catch (\Throwable $e) {
            error_log('[sala] error en la habitación ' . basename($file) . ': ' . $e->getMessage());
            continue;
        }
        if (!is_array($room)) {
            error_log("[sala] la habitación no devuelve un arreglo: {$file}");
            continue;
        }
        $id = preg_replace('/[^a-z0-9_-]/i', '', (string) ($room['id'] ?? basename($file, '.php')));
        if ($id !== '') {
            $raw[strtolower($id)] = $room;
        }
    }

    foreach (glob(__DIR__ . '/templates/*.json') ?: [] as $file) {
        $data = json_decode((string) file_get_contents($file), true);
        if (!is_array($data)) {
            error_log("[sala] JSON de habitación inválido: {$file}");
            continue;
        }
        $id = preg_replace('/[^a-z0-9_-]/i', '', (string) ($data['id'] ?? basename($file, '.json')));
        if ($id !== '') {
            $raw[strtolower($id)] = $data;
        }
    }

    $templates = [];
    foreach ($raw as $id => $tpl) {
        $normalized = sala_normalize_template((string) $id, $tpl);
        if ($normalized !== null) {
            $templates[$normalized['id']] = $normalized;
        }
    }

    // Orden del selector: por "order" y, a igualdad, por nombre.
    uasort($templates, static fn(array $a, array $b) => [$a['order'], $a['name']] <=> [$b['order'], $b['name']]);

    if (!$templates) {
        error_log('[sala] no hay ninguna habitación válida en rooms/ ni en templates/');
    }
    return $templates;
}

$templates = sala_load_templates();

// Habitación por defecto: ROOM_DEFAULT, la marcada con "default" o la primera.
$defaultRoom = (string) sala_env('ROOM_DEFAULT', '');
if (!isset($templates[$defaultRoom])) {
    $defaultRoom = '';
    foreach ($templates as $tplId => $tpl) {
        if ($tpl['default']) {
            $defaultRoom = (string) $tplId;
            break;
        }
    }
}
if ($defaultRoom === '') {
    $defaultRoom = (string) array_key_first($templates);
}

$roomMode = (string) sala_env('ROOM_MODE', 'sequential');
$yieldMode = (string) sala_env('ROOM_YIELD_MODE', 'llm');

return [
    'app_name' => 'Team Room',

    // Contraseña global de acceso (texto plano o hash de password_hash()).
    'password' => (string) sala_env('APP_PASSWORD', 'cambia-esta-clave'),

    'gemini' => [
        'api_key' => (string) sala_env('GEMINI_API_KEY', 'TU_API_KEY'),

        // gemini-1.5-flash ya fue discontinuado por Google: usa un modelo vigente.
        // Si el principal responde "no encontrado", saturado o sin cuota, se prueban los de respaldo en orden.
        'model' => (string) sala_env('GEMINI_MODEL', 'gemini-3.8-flash'),
        'fallback_models' => array_values(array_filter(array_map(
            'trim',
            explode(',', (string) sala_env('GEMINI_FALLBACK_MODELS', 'gemini-3.1-flash-lite,gemini-3-flash-preview'))
        ))),

        'endpoint' => (string) sala_env('GEMINI_ENDPOINT', 'https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent'),
        'temperature' => 0.7,
        'max_output_tokens' => 4096,
        'timeout' => 60, // segundos
    ],

    'limits' => [
        'max_message_chars' => 12000,   // por mensaje
        'max_history_messages' => 40,   // mensajes previos que se envían al modelo
        'max_history_chars' => 60000,   // presupuesto total de contexto
        'max_request_bytes' => 14 * 1024 * 1024, // tamaño máximo de una petición (incluye imágenes en base64)
    ],

    // Imágenes adjuntas (visión multimodal de Gemini).
    'images' => [
        'types' => ['image/png', 'image/jpeg', 'image/webp'],
        'max_bytes' => 4 * 1024 * 1024, // por imagen ya decodificada
        'max_side' => 1600,             // el navegador reduce las imágenes a este lado máximo antes de enviarlas
        'history_images' => 1,          // imágenes de mensajes anteriores que se reenvían para seguir la conversación
    ],

    // Cómo colaboran los agentes en cada ronda.
    'orchestration' => [
        // sequential: cada agente responde tras el anterior y ve lo que dijeron (más lento, más coordinado).
        // parallel: todos a la vez; solo ven las respuestas de rondas anteriores.
        // Si el usuario nombra a un agente, la ronda siempre es en paralelo (los demás solo ceden el turno).
        'mode' => in_array($roomMode, ['sequential', 'parallel'], true) ? $roomMode : 'sequential',
        'peer_messages' => 2,   // últimas respuestas de CADA otro agente que recibe un agente como contexto
        'peer_chars' => 700,    // máximo de caracteres por respuesta ajena
        // llm: el agente que cede el turno lo dice con su propia voz (gasta una llamada).
        // canned: frase fija sin llamar a Gemini (ahorra cuota).
        'yield_mode' => in_array($yieldMode, ['llm', 'canned'], true) ? $yieldMode : 'llm',
    ],

    'emotions' => sala_emotions(),

    'default_template' => $defaultRoom,
    'templates' => $templates,
];
