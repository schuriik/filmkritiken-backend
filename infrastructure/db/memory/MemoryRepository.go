// Package memory provides an in-memory implementation of the repositories.
// It is meant for local development only, when no MongoDB is available.
// All data is lost when the process exits.
package memory

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/DerBlum/filmkritiken-backend/domain/errors"
	"github.com/DerBlum/filmkritiken-backend/domain/filmkritiken"
	"github.com/DerBlum/filmkritiken-backend/domain/session"
)

type memoryRepository struct {
	mutex        sync.RWMutex
	filmkritiken map[string]*filmkritiken.Filmkritiken
	images       map[string][]byte
	sessions     map[string]*session.Session
}

func NewMemoryRepository() *memoryRepository {
	return &memoryRepository{
		filmkritiken: make(map[string]*filmkritiken.Filmkritiken),
		images:       make(map[string][]byte),
		sessions:     make(map[string]*session.Session),
	}
}

func newId() string {
	bytes := make([]byte, 12)
	if _, err := rand.Read(bytes); err != nil {
		// crypto/rand never fails on supported platforms, fall back to a timestamp
		return hex.EncodeToString([]byte(time.Now().UTC().Format("20060102150405")))
	}
	return hex.EncodeToString(bytes)
}

func (repo *memoryRepository) FindFilmkritiken(ctx context.Context, filmkritikenId string) (*filmkritiken.Filmkritiken, error) {
	repo.mutex.RLock()
	defer repo.mutex.RUnlock()

	found, ok := repo.filmkritiken[filmkritikenId]
	if !ok {
		return nil, errors.NewNotFoundErrorFromString("Filmkritiken konnten nicht gefunden werden.")
	}

	return copyFilmkritiken(found), nil
}

func (repo *memoryRepository) GetFilmkritiken(ctx context.Context, filter *filmkritiken.FilmkritikenFilter) ([]*filmkritiken.Filmkritiken, int64, error) {
	repo.mutex.RLock()
	defer repo.mutex.RUnlock()

	matches := make([]*filmkritiken.Filmkritiken, 0, len(repo.filmkritiken))
	for _, candidate := range repo.filmkritiken {
		if matchesFilter(candidate, filter) {
			matches = append(matches, candidate)
		}
	}

	totalCount := int64(len(matches))
	sortFilmkritiken(matches, filter)

	if filter != nil && filter.Offset > 0 {
		if filter.Offset >= len(matches) {
			return make([]*filmkritiken.Filmkritiken, 0), totalCount, nil
		}
		matches = matches[filter.Offset:]
	}
	if filter != nil && filter.Limit > 0 && filter.Limit < len(matches) {
		matches = matches[:filter.Limit]
	}

	results := make([]*filmkritiken.Filmkritiken, 0, len(matches))
	for _, match := range matches {
		results = append(results, copyFilmkritiken(match))
	}

	return results, totalCount, nil
}

func matchesFilter(candidate *filmkritiken.Filmkritiken, filter *filmkritiken.FilmkritikenFilter) bool {
	if filter == nil {
		return true
	}

	search := filter.Suche
	if search == "" {
		search = filter.Titel
	}
	if search != "" {
		if candidate.Film == nil {
			return false
		}
		lowered := strings.ToLower(search)
		titel := strings.ToLower(candidate.Film.Titel)
		originaltitel := strings.ToLower(candidate.Film.Originaltitel)
		if !strings.Contains(titel, lowered) && !strings.Contains(originaltitel, lowered) {
			return false
		}
	}

	if filter.Jahr > 0 {
		besprochenAm := besprochenAm(candidate)
		if besprochenAm == nil || besprochenAm.UTC().Year() != filter.Jahr {
			return false
		}
	}

	if filter.BeitragVon != "" {
		if candidate.Details == nil {
			return false
		}
		if !strings.EqualFold(candidate.Details.BeitragVon, filter.BeitragVon) {
			return false
		}
	}

	return true
}

func sortFilmkritiken(matches []*filmkritiken.Filmkritiken, filter *filmkritiken.FilmkritikenFilter) {
	if filter != nil && filter.Sortierung == "beste" {
		sort.SliceStable(matches, func(i, j int) bool {
			avgI, hasI := averageWertung(matches[i])
			avgJ, hasJ := averageWertung(matches[j])
			if hasI != hasJ {
				// like MongoDB, documents without any rating sort last on a descending sort
				return hasI
			}
			if hasI && avgI != avgJ {
				return avgI > avgJ
			}
			return besprochenAmOrZero(matches[i]).After(besprochenAmOrZero(matches[j]))
		})
		return
	}

	ascending := filter != nil && filter.Sortierung == "aelteste"
	sort.SliceStable(matches, func(i, j int) bool {
		left := besprochenAmOrZero(matches[i])
		right := besprochenAmOrZero(matches[j])
		if ascending {
			return left.Before(right)
		}
		return left.After(right)
	})
}

func averageWertung(item *filmkritiken.Filmkritiken) (float64, bool) {
	if len(item.Bewertungen) == 0 {
		return 0, false
	}

	sum := 0
	for _, bewertung := range item.Bewertungen {
		sum += bewertung.Wertung
	}

	return float64(sum) / float64(len(item.Bewertungen)), true
}

func besprochenAm(item *filmkritiken.Filmkritiken) *time.Time {
	if item.Details == nil {
		return nil
	}
	return item.Details.BesprochenAm
}

func besprochenAmOrZero(item *filmkritiken.Filmkritiken) time.Time {
	if value := besprochenAm(item); value != nil {
		return *value
	}
	return time.Time{}
}

func (repo *memoryRepository) SaveFilmkritiken(ctx context.Context, item *filmkritiken.Filmkritiken) error {
	repo.mutex.Lock()
	defer repo.mutex.Unlock()

	if item.Id == "" {
		item.Id = newId()
	}
	repo.filmkritiken[item.Id] = copyFilmkritiken(item)

	return nil
}

func (repo *memoryRepository) UpdateBesprochenAm(ctx context.Context, filmkritikenId string, besprochenAm time.Time) error {
	repo.mutex.Lock()
	defer repo.mutex.Unlock()

	found, ok := repo.filmkritiken[filmkritikenId]
	if !ok {
		return errors.NewNotFoundErrorFromString("Filmkritiken konnten nicht gefunden werden.")
	}

	if found.Details == nil {
		found.Details = &filmkritiken.FilmkritikenDetails{}
	}
	found.Details.BesprochenAm = &besprochenAm

	return nil
}

func (repo *memoryRepository) GetFilterOptions(ctx context.Context) (*filmkritiken.FilterOptions, error) {
	repo.mutex.RLock()
	defer repo.mutex.RUnlock()

	yearSet := make(map[int]bool)
	contributorSet := make(map[string]bool)
	for _, item := range repo.filmkritiken {
		if value := besprochenAm(item); value != nil {
			if year := value.UTC().Year(); year > 0 {
				yearSet[year] = true
			}
		}
		if item.Details != nil && item.Details.BeitragVon != "" {
			contributorSet[item.Details.BeitragVon] = true
		}
	}

	jahre := make([]int, 0, len(yearSet))
	for year := range yearSet {
		jahre = append(jahre, year)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(jahre)))

	beitragende := make([]string, 0, len(contributorSet))
	for contributor := range contributorSet {
		beitragende = append(beitragende, contributor)
	}
	sort.Strings(beitragende)

	return &filmkritiken.FilterOptions{
		Jahre:       jahre,
		Beitragende: beitragende,
	}, nil
}

func (repo *memoryRepository) SaveImage(ctx context.Context, imageBites *[]byte) (string, error) {
	repo.mutex.Lock()
	defer repo.mutex.Unlock()

	id := newId()
	stored := make([]byte, 0)
	if imageBites != nil {
		stored = append(stored, *imageBites...)
	}
	repo.images[id] = stored

	return id, nil
}

func (repo *memoryRepository) FindImage(ctx context.Context, imageId string) (*[]byte, error) {
	repo.mutex.RLock()
	defer repo.mutex.RUnlock()

	stored, ok := repo.images[imageId]
	if !ok {
		return nil, errors.NewNotFoundErrorFromString("Bild konnte nicht gefunden werden.")
	}

	result := make([]byte, len(stored))
	copy(result, stored)

	return &result, nil
}

func (repo *memoryRepository) DeleteImage(ctx context.Context, imageId string) error {
	repo.mutex.Lock()
	defer repo.mutex.Unlock()

	delete(repo.images, imageId)

	return nil
}

func (repo *memoryRepository) SaveSession(ctx context.Context, s *session.Session) error {
	repo.mutex.Lock()
	defer repo.mutex.Unlock()

	if s.ID == "" {
		s.ID = newId()
	}
	if s.CreatedAt.IsZero() {
		s.CreatedAt = time.Now()
	}

	stored := *s
	stored.ID = session.HashSessionID(s.ID)
	stored.Permissions = append([]string(nil), s.Permissions...)
	repo.sessions[stored.ID] = &stored

	return nil
}

func (repo *memoryRepository) FindSession(ctx context.Context, sessionID string) (*session.Session, error) {
	if sessionID == "" {
		return nil, errors.NewNotFoundErrorFromString("Session-ID ist leer.")
	}

	repo.mutex.RLock()
	stored, ok := repo.sessions[session.HashSessionID(sessionID)]
	if !ok {
		repo.mutex.RUnlock()
		return nil, errors.NewNotFoundErrorFromString("Session nicht gefunden.")
	}
	result := *stored
	result.Permissions = append([]string(nil), stored.Permissions...)
	repo.mutex.RUnlock()

	if time.Now().After(result.ExpiresAt) {
		_ = repo.DeleteSession(ctx, sessionID)
		return nil, errors.NewNotFoundErrorFromString("Session ist abgelaufen.")
	}

	result.ID = sessionID

	return &result, nil
}

func (repo *memoryRepository) DeleteSession(ctx context.Context, sessionID string) error {
	if sessionID == "" {
		return nil
	}

	repo.mutex.Lock()
	defer repo.mutex.Unlock()

	delete(repo.sessions, session.HashSessionID(sessionID))

	return nil
}

func (repo *memoryRepository) RefreshSession(ctx context.Context, sessionID string, duration time.Duration) error {
	if sessionID == "" {
		return errors.NewNotFoundErrorFromString("Session-ID ist leer.")
	}

	repo.mutex.Lock()
	defer repo.mutex.Unlock()

	stored, ok := repo.sessions[session.HashSessionID(sessionID)]
	if !ok {
		return errors.NewNotFoundErrorFromString("Session für Refresh nicht gefunden.")
	}
	stored.ExpiresAt = time.Now().Add(duration)

	return nil
}

func copyFilmkritiken(source *filmkritiken.Filmkritiken) *filmkritiken.Filmkritiken {
	if source == nil {
		return nil
	}

	result := &filmkritiken.Filmkritiken{
		Id:          source.Id,
		Bewertungen: make([]*filmkritiken.Bewertung, 0, len(source.Bewertungen)),
	}

	if source.Details != nil {
		details := *source.Details
		if source.Details.BesprochenAm != nil {
			besprochenAm := *source.Details.BesprochenAm
			details.BesprochenAm = &besprochenAm
		}
		result.Details = &details
	}

	if source.Film != nil {
		film := *source.Film
		if source.Film.Image != nil {
			image := *source.Film.Image
			film.Image = &image
		}
		result.Film = &film
	}

	for _, bewertung := range source.Bewertungen {
		if bewertung == nil {
			continue
		}
		copied := *bewertung
		result.Bewertungen = append(result.Bewertungen, &copied)
	}

	return result
}
