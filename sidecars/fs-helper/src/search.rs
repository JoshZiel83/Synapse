//! Search dispatch — content (FTS5) + path (nucleo fuzzy).

use nucleo_matcher::{
    pattern::{CaseMatching, Normalization, Pattern},
    Config, Matcher,
};

use crate::index::IndexStore;
use crate::rpc::{
    RpcError, SearchContentHit, SearchContentInput, SearchContentResult,
    SearchPathHit, SearchPathInput, SearchPathResult,
};

pub fn search_content(
    idx: &IndexStore,
    input: &SearchContentInput,
    max_limit: u32,
    max_offset: u32,
) -> Result<SearchContentResult, RpcError> {
    if input.regex {
        return Err(RpcError::InvalidParams("regex_requires_live_search".into()));
    }
    if input.glob.is_some() {
        return Err(RpcError::InvalidParams("glob_requires_live_search".into()));
    }
    validate_pagination(input.limit, input.offset, max_limit, max_offset)?;
    // FTS5 returns ordered hits; we over-fetch (offset+limit) so the slice
    // gives the right window.
    let target = (input.offset as usize) + (input.limit as usize);
    let mut hits: Vec<SearchContentHit> = Vec::new();
    idx.fts_search(
        &input.query,
        &input.allowed_path_prefixes,
        target,
        |path, score, snippet| {
            hits.push(SearchContentHit {
                path: path.to_string(),
                score,
                snippet: snippet.to_string(),
                line_no: None,
                byte_offset: None,
            });
        },
    )?;
    let sliced = hits
        .into_iter()
        .skip(input.offset as usize)
        .take(input.limit as usize)
        .collect();
    Ok(SearchContentResult { hits: sliced })
}

pub fn search_path(
    idx: &IndexStore,
    input: &SearchPathInput,
    max_limit: u32,
    max_offset: u32,
) -> Result<SearchPathResult, RpcError> {
    if input.regex {
        return Err(RpcError::InvalidParams("regex_requires_live_search".into()));
    }
    if input.glob.is_some() {
        return Err(RpcError::InvalidParams("glob_requires_live_search".into()));
    }
    validate_pagination(input.limit, input.offset, max_limit, max_offset)?;
    let mut candidates: Vec<String> = Vec::new();
    idx.iter_paths(&input.allowed_path_prefixes, |p| {
        candidates.push(p.to_string());
    })?;
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::parse(&input.query, CaseMatching::Smart, Normalization::Smart);
    let mut scored: Vec<(u32, String)> = candidates
        .into_iter()
        .filter_map(|p| {
            let score = pattern.score(
                nucleo_matcher::Utf32String::from(p.as_str()).slice(..),
                &mut matcher,
            )?;
            Some((score, p))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let hits: Vec<SearchPathHit> = scored
        .into_iter()
        .skip(input.offset as usize)
        .take(input.limit as usize)
        .map(|(score, p)| SearchPathHit { path: p, score: score as f64 })
        .collect();
    Ok(SearchPathResult { hits })
}

fn validate_pagination(
    limit: u32,
    offset: u32,
    max_limit: u32,
    max_offset: u32,
) -> Result<(), RpcError> {
    if limit == 0 || limit > max_limit {
        return Err(RpcError::InvalidParams(format!(
            "limit_out_of_range: 1..={max_limit}"
        )));
    }
    if offset > max_offset {
        return Err(RpcError::InvalidParams(format!(
            "offset_out_of_range: 0..={max_offset}"
        )));
    }
    Ok(())
}
