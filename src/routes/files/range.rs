use axum::http::{HeaderMap, header};

pub(super) enum Selection {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

pub(super) fn select(headers: &HeaderMap, size: u64) -> Selection {
    // No validators are emitted yet, so an If-Range condition cannot be matched.
    if headers.contains_key(header::IF_RANGE) {
        return Selection::Full;
    }
    let Some(value) = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    else {
        return Selection::Full;
    };
    let Some(bytes) = value.strip_prefix("bytes=") else {
        return Selection::Full;
    };
    // HTTP permits ignoring unsupported multi-range and malformed headers.
    if bytes.contains(',') {
        return Selection::Full;
    }
    let Some((start, end)) = bytes.split_once('-') else {
        return Selection::Full;
    };
    if start.is_empty() {
        let Ok(suffix) = end.parse::<u64>() else {
            return Selection::Full;
        };
        return if suffix == 0 || size == 0 {
            Selection::Unsatisfiable
        } else {
            Selection::Partial {
                start: size.saturating_sub(suffix),
                end: size - 1,
            }
        };
    }
    let Ok(start) = start.parse::<u64>() else {
        return Selection::Full;
    };
    let end = if end.is_empty() {
        size.saturating_sub(1)
    } else if let Ok(end) = end.parse::<u64>() {
        end
    } else {
        return Selection::Full;
    };
    if start >= size || start > end {
        return Selection::Unsatisfiable;
    }
    Selection::Partial {
        start,
        end: end.min(size - 1),
    }
}
