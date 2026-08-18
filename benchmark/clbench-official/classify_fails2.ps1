$gradedPath = 'D:\opencontext\benchmark\clbench-official\outputs\openloomi-cl_graded.jsonl'
$lines = Get-Content $gradedPath

$kw = @{
    'format_or_structure'      = @('format', 'table', 'column', 'markdown', 'json', 'bullet', 'list', 'structured', 'sort', 'alphabetical', 'chronological', 'header', 'row')
    'missing_required_content' = @('does not', "doesn", 'fail to', 'fails to', 'miss', 'omit', 'absent', 'missing', 'lack', 'not include', 'not mention', 'not state', 'not provide', 'fails to include', 'fails to mention', 'fails to state', 'fails to provide', 'does not include', 'does not mention')
    'incorrect_factual'        = @('incorrect', 'wrong', 'inaccurate', 'not match', 'inconsist', 'mismatch', 'does not reflect', 'contradict', 'conflated', 'confused', 'misattribute', 'erroneous')
    'partially_correct'        = @('partial', 'incomplete', 'not fully', 'does not fully', 'not all', 'only some', 'partially')
    'unclear_or_insufficient'  = @('unclear', 'ambiguous', 'vague', 'insufficient', 'cannot be determined', 'not enough')
    'irrelevant'               = @('not relevant', 'off-topic', 'irrelevant', 'unrelated')
    'missing_specific_detail'  = @('specific', 'named', 'name', 'numer', 'detail', 'cite', 'reference', 'quote', 'example', 'exact')
}

# Track: per-category count, and category-only count (this task only failed due to this category)
$catHits = @{}     # total hits per category (sum across tasks)
$catOnly = @{}     # tasks where ONLY this category matched
$totalFail = 0

foreach ($l in $lines) {
    try {
        $j = $l | ConvertFrom-Json
        if ([int]$j.score -ne 0) { continue }
        $totalFail++
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
            if (-not $catHits.ContainsKey('other')) { $catHits['other'] = 0; $catOnly['other'] = 0 }
            $catHits['other']++
            $catOnly['other']++
            continue
        }
        foreach ($h in $hits) {
            if (-not $catHits.ContainsKey($h)) { $catHits[$h] = 0; $catOnly[$h] = 0 }
            $catHits[$h]++
        }
        if ($hits.Count -eq 1) {
            $catOnly[$hits[0]]++
        }
    } catch {}
}

Write-Output ("total fail: $totalFail")
Write-Output ""
Write-Output "=== 类别命中次数（每个任务可命中多类别，累加）==="
Write-Output ("  {0,-30} {1,5} {2,7} {3,7}" -f 'category', 'hits', 'pct-of-fails', 'only-this')
foreach ($k in ($catHits.Keys | Sort-Object { $catHits[$_] } -Descending)) {
    $pct = [math]::Round($catHits[$k]/$totalFail*100, 1)
    $only = if ($catOnly.ContainsKey($k)) { $catOnly[$k] } else { 0 }
    Write-Output ("  {0,-30} {1,5} {2,6}% {3,7}" -f $k, $catHits[$k], $pct, $only)
}
