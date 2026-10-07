<?php
$req = json_decode(file_get_contents('php://input'), true);
$sys = $req['systemInstruction']['parts'][0]['text'] ?? '';
$user = end($req['contents'])['parts'][0]['text'] ?? '';
$imgs = []; foreach (($req['contents'] ?? []) as $ci => $c) foreach ($c['parts'] as $pi => $p) if (isset($p['inline_data'])) $imgs[] = ['turn' => $ci, 'part' => $pi, 'role' => $c['role'], 'mime' => $p['inline_data']['mime_type'], 'bytes' => strlen(base64_decode($p['inline_data']['data'])), 'last_turn' => $ci === count($req['contents']) - 1, 'first_part' => $pi === 0];
$seen = []; preg_match('/Tu nombre en la sala es ([^.]+)\./', $sys, $nm); $who = $nm[1] ?? '?'; file_put_contents('/tmp/fake/log.txt', sprintf("START %s %.3f\n", $who, microtime(true)), FILE_APPEND); usleep((is_file('/tmp/fake/delay') ? (int)file_get_contents('/tmp/fake/delay') : 220) * 1000); file_put_contents('/tmp/fake/img_' . preg_replace('/\W+/','_',$who) . '.json', json_encode(['imgs' => $imgs, 'sys_has_image_note' => str_contains($sys, 'IMAGEN ADJUNTA')])); file_put_contents('/tmp/fake/last_' . preg_replace('/\W+/','_',$who) . '.txt', $sys);
if (preg_match('/CONTEXTO DE LA SALA.*?\n(.*)$/s', $sys, $m)) {
    preg_match_all('/^- ([^\(:]+?)(?: \(|:)/m', $m[1], $mm); $seen = $mm[1];
}
if (str_contains($sys, 'TURNO DIRIGIDO A OTRO AGENTE')) {
    $text = str_contains($user, 'divaga') ? "[[emocion: happy]]\n" . str_repeat('palabra ', 60) : "[[emocion: neutral]]\nDejo esta solicitud en manos de " . (preg_match('/se dirigió explícitamente a (.+?), NO a ti/u', $sys, $tm) ? $tm[1] : '?') . ".";
} else {
    $mode = str_contains($sys, 'TURNO DIRIGIDO A TI') ? 'dirigido' : (str_contains($sys, 'TURNO ABIERTO') ? 'abierto' : '?');
    $len = strlen($sys);
    $text = "[[emocion: " . (str_contains($user, 'sorpresa') ? 'shocked' : 'happy') . "]]\n**Respuesta** ($mode) vio: " . implode('|', $seen) . " | brevedad75=" . (str_contains($sys, '75 palabras') ? 'si' : 'no') . " | img=" . count($imgs) . "\n\nFILLER: " . str_repeat('Estoy preparado para definir la arquitectura de componentes, mejorar la accesibilidad y pulir la experiencia de usuario de lo que necesites. ', 3) . "\n\n¿Qué proyecto tenemos entre manos? Cuéntame los objetivos principales para empezar a estructurar el layout y la guía de estilos.";
}
file_put_contents('/tmp/fake/log.txt', sprintf("END %s %.3f\n", $who, microtime(true)), FILE_APPEND);
header('Content-Type: application/json');
echo json_encode(['candidates' => [['content' => ['parts' => [['text' => $text]]], 'finishReason' => 'STOP']], 'usageMetadata' => ['promptTokenCount' => 1, 'candidatesTokenCount' => 1]]);
