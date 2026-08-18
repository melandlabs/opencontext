$gradedPath = 'D:\opencontext\benchmark\clbench-official\outputs\openloomi-cl_graded.jsonl'
$lines = Get-Content $gradedPath

$kw = @{
    'format_or_structure'      = @('format', 'table', 'column', 'markdown', 'json', 'bullet', 'list', 'structured', 'sort', 'alphabetical', 'chronological', 'header', 'row')
    'missing_required_content' = @('does not', "doesn", 'fail to', 'fails to', 'miss', 'omit', 'absent', 'missing', 'lack', 'not include', 'not mention', 'not state', 'not provide')
    'incorrect_factual'        = @('incorrect', 'wrong', 'inaccurate', 'not match', 'inconsist', 'mismatch', 'does not reflect', 'contradict', 'conflated', 'confused', 'misattribute', 'erroneous')
    'partially_correct'        = @('partial', 'incomplete', 'not fully', 'does not fully', 'not all', 'only some', 'partially')
    'unclear_or_insufficient'  = @('unclear', 'ambiguous', 'vague', 'insufficient', 'cannot be determined', 'not enough')
    'irrelevant'               = @('not relevant', 'off-topic', 'irrelevant', 'unrelated')
    'missing_specific_detail'  = @('specific', 'named', 'name', 'numer', 'detail', 'cite', 'reference', 'quote', 'example', 'exact')
}

$totalFail = 0
$totalPass = 0
$primary = @{}      # primary reason = first hit (priority order)
$singleCause = @{}  # tasks with only one cause

$priority = @('incorrect_factual', 'irrelevant', 'partially_correct', 'unclear_or_insufficient',
              'missing_required_content', 'missing_specific_detail', 'format_or_structure')

foreach ($l in $lines) {
    try {
        $j = $l | ConvertFrom-Json
        if ([int]$j.score -eq 1) { $totalPass++; continue }
        $totalFail++
        $r = $j.grading_rationale.ToLower()
        $hits = @()
        foreach ($cat in $priority) {
            foreach ($w in $kw[$cat]) {
                if ($r -match [regex]::Escape($w)) { $hits += $cat; break }
            }
        }
        if ($hits.Count -eq 0) { $hits = @('other') }
        $p = $hits[0]
        if (-not $primary.ContainsKey($p)) { $primary[$p] = 0 }
        $primary[$p]++
        if ($hits.Count -eq 1) {
            if (-not $singleCause.ContainsKey($p)) { $singleCause[$p] = 0 }
            $singleCause[$p]++
        }
    } catch {}
}

Write-Output ("=== total pass=$totalPass, fail=$totalFail ===")
Write-Output ""
Write-Output "=== 主因分类（每个失败任务归到一个主类）==="
foreach ($k in ($primary.Keys | Sort-Object { $primary[$_] } -Descending)) {
    $pct = [math]::Round($primary[$k]/$totalFail*100, 1)
    $only = if ($singleCause.ContainsKey($k)) { $singleCause[$k] } else { 0 }
    Write-Output ("  {0,-30} : {1,4} ({2,5}%)   only-this-cause: {3}" -f $k, $primary[$k], $pct, $only)
}
Write-Output ""
Write-Output "=== 失败任务中，'仅此一个原因' 的任务分布 ==="
foreach ($k in ($singleCause.Keys | Sort-Object { $singleCause[$_] } -Descending)) {
    Write-Output ("  $k : $($singleCause[$k])")
}
