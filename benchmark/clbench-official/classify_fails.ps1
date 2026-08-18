$gradedPath = 'D:\opencontext\benchmark\clbench-official\outputs\openloomi-cl_graded.jsonl'
$lines = Get-Content $gradedPath

$totalFail = 0; $totalPass = 0
foreach ($l in $lines) {
    try {
        $j = $l | ConvertFrom-Json
        $s = if ($j.PSObject.Properties.Name -contains 'score') { [int]$j.score } else { -1 }
        if ($s -eq 0) { $totalFail++ } elseif ($s -eq 1) { $totalPass++ }
    } catch {}
}
Write-Output ("pass: $totalPass")
Write-Output ("fail: $totalFail")
Write-Output ""

# Pre-compute keyword arrays (avoid escape issues)
$kw = @{
    'format_or_structure'      = @('format', 'table', 'column', 'markdown', 'json', 'bullet', 'list', 'structured', 'sort', 'alphabetical', 'chronological')
    'missing_required_content' = @('does not', "doesn", 'fail to', 'fails to', 'miss', 'omit', 'absent', 'missing', 'lack', 'not include', 'not mention', 'not state', 'not provide')
    'incorrect_factual'        = @('incorrect', 'wrong', 'inaccurate', 'not match', 'inconsist', 'mismatch', 'does not reflect', 'contradict', 'conflated', 'confused', 'misattribute')
    'partially_correct'        = @('partial', 'incomplete', 'not fully', 'does not fully', 'not all', 'only some', 'partially')
    'unclear_or_insufficient'  = @('unclear', 'ambiguous', 'vague', 'insufficient', 'cannot be determined', 'not enough')
    'irrelevant'               = @('not relevant', 'off-topic', 'irrelevant', 'unrelated')
    'missing_specific_detail'  = @('specific', 'named', 'name', 'numer', 'detail', 'cite', 'reference', 'quote', 'example', 'exact')
}

$fails = @{}
$multiCount = 0

foreach ($l in $lines) {
    try {
        $j = $l | ConvertFrom-Json
        if ([int]$j.score -ne 0) { continue }
        $r = $j.grading_rationale.ToLower()
        $hits = @()
        foreach ($cat in $kw.Keys) {
            foreach ($w in $kw[$cat]) {
                if ($r -match [regex]::Escape($w)) {
                    $hits += $cat
                    break
                }
            }
        }
        if ($hits.Count -eq 0) {
            $cat = 'other'
        } elseif ($hits.Count -gt 1) {
            $multiCount++
            $cat = 'multi:' + ($hits -join '+')
        } else {
            $cat = $hits[0]
        }
        if (-not $fails.ContainsKey($cat)) { $fails[$cat] = 0 }
        $fails[$cat]++
    } catch {}
}

Write-Output "=== 失败原因分类 ==="
foreach ($k in ($fails.Keys | Sort-Object { $fails[$_] } -Descending)) {
    $pct = [math]::Round($fails[$k]/$totalFail*100, 1)
    Write-Output ("  {0,-30} : {1,4} ({2,5}%)" -f $k, $fails[$k], $pct)
}
Write-Output ""
Write-Output ("multi-category (>=2 类别命中): $multiCount")
