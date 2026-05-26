//! Search dispatch — content (substring) + path (substring/fuzzy).

use crate::index::{allowed, IndexStore};
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
        return Err(RpcError::InvalidParams(
            "regex_requires_live_search".into(),
        ));
    }
    if input.glob.is_some() {
        return Err(RpcError::InvalidParams(
            "glob_requires_live_search".into(),
        ));
    }
    validate_pagination(input.limit, input.offset, max_limit, max_offset)?;
    let needle = &input.query;
    let mut hits: Vec<SearchContentHit> = Vec::new();
    let target = input.offset as usize + input.limit as usize;
    idx.all_paths_with_content(|path, content| {
        if hits.len() >= target {
            return;
        }
        if !allowed(path, &input.allowed_path_prefixes) {
            return;
        }
        let lower = content.to_lowercase();
        let needle_lower = needle.to_lowercase();
        if !lower.contains(&needle_lower) {
            return;
        }
        // line + offset of first match
        let idx_pos = lower.find(&needle_lower).unwrap();
        let line_no = content[..idx_pos].matches('\n').count() as u32 + 1;
        let line_start = content[..idx_pos].rfind('\n').map(|p| p + 1).unwrap_or(0);
        let line_end = content[idx_pos..]
            .find('\n')
            .map(|p| idx_pos + p)
            .unwrap_or(content.len());
        let snippet = content[line_start..line_end].to_string();
        hits.push(SearchContentHit {
            path: path.to_string(),
            score: 1.0,
            snippet,
            line_no: Some(line_no),
            byte_offset: Some(idx_pos as u32),
        });
    })?;
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
        return Err(RpcError::InvalidParams(
            "regex_requires_live_search".into(),
        ));
    }
    if input.glob.is_some() {
        return Err(RpcError::InvalidParams(
            "glob_requires_live_search".into(),
        ));
    }
    validate_pagination(input.limit, input.offset, max_limit, max_offset)?;
    let needle = input.query.to_lowercase();
    let mut hits: Vec<SearchPathHit> = Vec::new();
    let target = input.offset as usize + input.limit as usize;
    idx.all_paths_with_content(|path, _content| {
        if hits.len() >= target {
            return;
        }
        if !allowed(path, &input.allowed_path_prefixes) {
            return;
        }
        let lp = path.to_lowercase();
        let score = if needle.is_empty() {
            1.0
        } else if lp.contains(&needle) {
            // Simple fuzzy-ish score: shorter paths score higher.
            1.0 - (path.len() as f64 / 1000.0).min(1.0)
        } else {
            return;
        };
        hits.push(SearchPathHit {
            path: path.to_string(),
            score,
        });
    })?;
    let sliced = hits
        .into_iter()
        .skip(input.offset as usize)
        .take(input.limit as usize)
        .collect();
    Ok(SearchPathResult { hits: sliced })
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
