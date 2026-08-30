const fs = require('fs');

// Read HTML structure
const html = fs.readFileSync('./src/renderer.html', 'utf8');
const scriptMatch = html.match(/<script(?:[^>]*)>([\s\S]*?)<\/script>/i);
const beforeScript = html.substring(0, scriptMatch.index);
const afterScript = html.substring(scriptMatch.index + scriptMatch[0].length);

// Read complete script
let script = fs.readFileSync('./renderer-script.js', 'utf8');

// Remove duplicate ntSearchKey (it appears on consecutive lines)
const lines = script.split('\n');
let cleanLines = [];
let prevLine = '';
for (let i = 0; i < lines.length; i++) {
  const currentLine = lines[i];
  // Skip if this line is identical to the previous line and both have ntSearchKey
  if (currentLine === prevLine && currentLine.includes('function ntSearchKey')) {
    console.log('✓ Skipped duplicate at line', i + 1);
    continue;
  }
  cleanLines.push(currentLine);
  prevLine = currentLine;
}
script = cleanLines.join('\n');

// Rebuild HTML
const newHtml = beforeScript + '<script>\n' + script + '\n</script>' + afterScript;

// Write back
fs.writeFileSync('./src/renderer.html', newHtml, 'utf8');
console.log('✓ Rebuilt renderer.html with complete script');
console.log('  New size:', (newHtml.length / 1024).toFixed(1), 'KB');

// Verify it parses
try {
  new Function(script);
  console.log('✓ Script parses OK!');
} catch (e) {
  console.log('✗ Parse error:', e.message);
}
