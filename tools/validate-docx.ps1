param([string]$Path = "$env:TEMP\mc-docx-smoke.docx")
# Validacion independiente del .docx generado: abre el paquete con
# System.IO.Compression de .NET y parsea cada parte XML con XmlDocument.
# Si esto pasa, el ZIP y el OOXML son correctos segun una implementacion que
# no es la nuestra.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
try {
  Write-Output "entradas: $($zip.Entries.Count)"
  $ok = $true
  foreach ($e in $zip.Entries) {
    $len = $e.Length
    if ($e.FullName -match '\.(xml|rels)$') {
      $sr = New-Object System.IO.StreamReader($e.Open())
      $text = $sr.ReadToEnd(); $sr.Close()
      try {
        $doc = New-Object System.Xml.XmlDocument
        $doc.LoadXml($text)
        Write-Output ("  OK  {0,-38} {1,7} bytes  root=<{2}>" -f $e.FullName, $len, $doc.DocumentElement.Name)
      } catch {
        $ok = $false
        Write-Output ("  XML MAL FORMADO {0}: {1}" -f $e.FullName, $_.Exception.Message)
      }
    } else {
      Write-Output ("  --  {0,-38} {1,7} bytes (binario)" -f $e.FullName, $len)
    }
  }
  $names = $zip.Entries | ForEach-Object { $_.FullName }
  foreach ($req in @('[Content_Types].xml','_rels/.rels','word/document.xml','word/_rels/document.xml.rels')) {
    if ($names -notcontains $req) { $ok = $false; Write-Output "  FALTA la parte obligatoria $req" }
  }
  Write-Output $(if ($ok) { 'RESULTADO: paquete valido' } else { 'RESULTADO: con problemas' })
} finally { $zip.Dispose() }
